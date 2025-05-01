// index.js
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

// osiguraj da radimo u folderu gdje je index.js
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

// Folder u kojem su configA.json, configB.json, …
const CONFIG_DIR = path.join(__dirname, 'configs');

// Učitaj sve config imena (bez .json)
let configNames;
try {
  configNames = fs.readdirSync(CONFIG_DIR)
                  .filter(f => f.endsWith('.json'))
                  .map(f => f.replace(/\.json$/, ''));
} catch (err) {
  console.error(`Ne mogu naći folder configs/: ${err.message}`);
  process.exit(1);
}

const configs = {};          // configName → { bases, baseManifests }
const manifests = {};        // configName → wrapper manifest

// Inicijaliziraj svaki config
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
    .map(u => u.trim()
               .replace(/\/+$/, '')
               .replace(/\/manifest\.json$/i, ''))
    .filter(Boolean);

  // fetch manifesta
  const baseManifests = [];
  await Promise.all(bases.map(async b => {
    try {
      const r = await axios.get(`${b}/manifest.json`);
      if (r.data.catalogs) baseManifests.push({ base: b, manifest: r.data });
    } catch (_){}
  }));

  if (!baseManifests.length) {
    console.error(`Config ${name} nema validnih baza → skip`);
    return;
  }

  configs[name] = { bases, baseManifests };

  // build wrapper manifest
  const ms = baseManifests.map(bm => bm.manifest);
  manifests[name] = {
    id:           `stremio-proxy-wrapper-${name}`,
    version:      '1.0.0',
    name:         `Stremio Proxy Wrapper (${name})`,
    description:  'Proxy svih vaših Stremio addon-a',
    resources:    ['catalog','meta','stream','subtitles'],
    types:        [...new Set(ms.flatMap(m=>m.types||[]))],
    idPrefixes:   [...new Set(ms.flatMap(m=>m.idPrefixes||[]))],
    catalogs:     ms.flatMap(m=>m.catalogs||[]),
    logo:         ms[0]?.logo  || '',
    icon:         ms[0]?.icon  || '',
  };

  console.log(`✅ Inicijaliziran config ${name}: ${bases.length} baza, ${manifests[name].catalogs.length} katalog stavki`);
}

// učitaj
Promise.all(configNames.map(initConfig))
  .then(()=>console.log(`🎉 Svi configi spremni: ${configNames.join(', ')}`))
  .catch(err => { console.error(err); process.exit(1); });

// manifest endpoint
app.get('/:conf/manifest.json', (req,res) => {
  const w = manifests[req.params.conf];
  if (!w) return res.status(404).json({ error: 'Config ne postoji' });
  res.json(w);
});

// V4 POST -> V3 GET za catalog/meta/stream/subtitles
async function proxyV4(req, res, key, route) {
  const cfg = configs[req.params.conf];
  if (!cfg) return res.json({ [key]: [] });

  // za catalog filtriraj po id
  let targets = cfg.baseManifests;
  if (key==='metas') {
    const id = req.body.id;
    targets = targets.filter(bm => bm.manifest.catalogs.some(c=>c.id===id));
  }

  // podrška za extra query string
  const qs = (req.body.extra||[])
    .map(e=>`${encodeURIComponent(e.name)}=${encodeURIComponent(e.value)}`)
    .join('&');
  const suffix = qs ? `?${qs}` : '';

  const all = [];
  await Promise.all(targets.map(async bm=>{
    try {
      const url = `${bm.base}/${route}/${req.body.type}/${req.body.id}.json${suffix}`;
      const r = await axios.get(url);
      if (Array.isArray(r.data[key])) all.push(...r.data[key]);
    } catch(_) {}
  }));
  res.json({ [key]: all });
}

app.post('/:conf/catalog',   (req,res)=>proxyV4(req,res,'metas',   'catalog'));
app.post('/:conf/meta',      (req,res)=>proxyV4(req,res,'metas',   'meta'));
app.post('/:conf/stream',    (req,res)=>proxyV4(req,res,'streams','stream'));
app.post('/:conf/subtitles', (req,res)=>proxyV4(req,res,'subtitles','subtitles'));

// fallback V3 GET ruta
app.get('/:conf/:rest(*)', async (req,res)=>{
  const cfg = configs[req.params.conf];
  if (!cfg) return res.status(404).json({ error:'Config ne postoji' });

  const p = req.params.rest;
  let key;
  if (p.startsWith('catalog/'))   key='metas';
  else if (p.startsWith('stream/'))   key='streams';
  else if (p.startsWith('subtitles/'))key='subtitles';
  else return res.status(404).json({ error:'Not found' });

  // za catalog: filtriraj po id
  const parts = p.split('/');
  const id = (key==='metas') ? parts[2].replace('.json','') : null;

  const all = [];
  await Promise.all(cfg.baseManifests.map(async bm=>{
    if (key==='metas' && !bm.manifest.catalogs.some(c=>c.id===id)) return;
    try {
      const r = await axios.get(`${bm.base}/${p}`,{ headers:req.headers });
      if (Array.isArray(r.data[key])) all.push(...r.data[key]);
    } catch(_) {}
  }));
  res.json({ [key]: all });
});

// start
const PORT = process.env.PORT||7000;
app.listen(PORT,()=>console.log(`🔌 Listening on :${PORT}`));
