// index.js
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

// osiguraj da smo u folderu gdje leži index.js
process.chdir(path.dirname(__filename));

const app = express();

// CORS
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin',  '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// folder s config fajlovima: configA.json, configB.json, …
const CONFIG_DIR = path.join(__dirname, 'configs');

// pronadji sve config imena
let configNames;
try {
  configNames = fs.readdirSync(CONFIG_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''));
} catch (err) {
  console.error(`Ne mogu naći folder configs/: ${err.message}`);
  process.exit(1);
}

const configs       = {}; // configName -> { bases, baseManifests }
const wrapperManifests = {}; // configName -> wrapper manifest

// inicijaliziraj jedan config
async function initConfig(name) {
  const cfgPath = path.join(CONFIG_DIR, `${name}.json`);
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath));
  } catch (e) {
    console.error(`Greška pri parsiranju ${cfgPath}: ${e.message}`);
    return;
  }

  // očisti URL-ove
  const bases = (cfg.TARGET_ADDON_BASES || [])
    .map(u => u.trim().replace(/\/manifest\.json$/i,'').replace(/\/+$/,''))
    .filter(Boolean);

  // fetch svakog manifesta
  const baseManifests = [];
  await Promise.all(bases.map(async b => {
    try {
      const r = await axios.get(`${b}/manifest.json`);
      if (r.data.catalogs) baseManifests.push({ base: b, manifest: r.data });
    } catch(_) {}
  }));

  if (!baseManifests.length) {
    console.error(`Config ${name} nema validnih baza → skip`);
    return;
  }

  configs[name] = { bases, baseManifests };

  // napravi wrapper manifest
  const ms = baseManifests.map(bm => bm.manifest);
  wrapperManifests[name] = {
    id:          `stremio-proxy-wrapper-${name}`,
    version:     '1.0.0',
    name:        `Stremio Proxy Wrapper (${name})`,
    description: 'Proxy svih vaših Stremio addon-a',
    resources:   ['catalog','meta','stream','subtitles'],
    types:       [...new Set(ms.flatMap(m=>m.types||[]))],
    idPrefixes:  [...new Set(ms.flatMap(m=>m.idPrefixes||[]))],
    catalogs:    ms.flatMap(m=>m.catalogs||[]),
    logo:        ms[0]?.logo  || '',
    icon:        ms[0]?.icon  || ''
  };

  console.log(`✅ Inicijaliziran config ${name}: ${bases.length} baza, ${wrapperManifests[name].catalogs.length} katalog stavki`);
}

// inicijaliziraj sve
Promise.all(configNames.map(initConfig))
  .then(()=>console.log(`🎉 Svi configi spremni: ${configNames.join(', ')}`))
  .catch(err => { console.error(err); process.exit(1); });

// endpoint za manifest
app.get('/:conf/manifest.json', (req,res) => {
  const m = wrapperManifests[req.params.conf];
  if (!m) return res.status(404).json({ error: 'Config ne postoji' });
  res.json(m);
});

// generički POST–handler
function makePostHandler(key, route) {
  return async (req, res) => {
    const cfg = configs[req.params.conf];
    if (!cfg) return res.json({ [key]: [] });

    let targets = cfg.baseManifests;
    // za catalog, filtriraj po id
    if (key === 'metas') {
      const id = req.body.id;
      targets = targets.filter(bm => bm.manifest.catalogs.some(c=>c.id===id));
    }

    const responses = await Promise.all(
      targets.map(bm =>
        axios.post(`${bm.base}/${route}`, req.body, {
          headers: {'Content-Type':'application/json'}
        })
        .then(r=>r.data)
        .catch(()=>null)
      )
    );

    const combined = responses.reduce((acc, r) => {
      if (r && Array.isArray(r[key])) acc.push(...r[key]);
      return acc;
    }, []);
    res.json({ [key]: combined });
  }
}

// V4 POST rute
app.post('/:conf/catalog',   makePostHandler('metas',     'catalog'));
app.post('/:conf/meta',      makePostHandler('metas',     'meta'));
app.post('/:conf/stream',    makePostHandler('streams',   'stream'));
app.post('/:conf/subtitles', makePostHandler('subtitles','subtitles'));

// fallback V3 GET
app.get('/:conf/:rest(*)', async (req,res) => {
  const cfg = configs[req.params.conf];
  if (!cfg) return res.status(404).json({ error:'Config ne postoji' });

  const p = req.params.rest;
  let key;
  if (p.startsWith('catalog/'))    key='metas';
  else if (p.startsWith('stream/'))   key='streams';
  else if (p.startsWith('subtitles/'))key='subtitles';
  else return res.status(404).json({ error:'Not found' });

  const parts = p.split('/');
  const id = (key==='metas') ? parts[2].replace('.json','') : null;

  const all = [];
  await Promise.all(cfg.baseManifests.map(async bm => {
    if (key==='metas' && !bm.manifest.catalogs.some(c=>c.id===id)) return;
    try {
      const r = await axios.get(`${bm.base}/${p}`, { headers: req.headers });
      if (Array.isArray(r.data[key])) all.push(...r.data[key]);
    } catch(_) {}
  }));

  res.json({ [key]: all });
});

// start server
const PORT = process.env.PORT || 7000;
app.listen(PORT, ()=>console.log(`🔌 Listening on :${PORT}`));
