// index.js
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

// osiguraj da smo u folderu gdje je ovaj fajl
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

// Folder s config fajlovima (configA.json, configB.json,…)
const CONFIG_DIR = path.join(__dirname, 'configs');
let configNames;
try {
  configNames = fs.readdirSync(CONFIG_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''));
  console.log(`📂 Pronađeni configi: ${configNames.join(', ')}`);
} catch (err) {
  console.error(`❌ Ne mogu čitati folder configs/: ${err.message}`);
  process.exit(1);
}

const configs         = {}; // configName -> { bases, baseManifests }
const wrapperManifests = {}; // configName -> manifest JSON

// inicijaliziraj jedan config
async function initConfig(name) {
  const cfgPath = path.join(CONFIG_DIR, `${name}.json`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    console.error(`❌ Greška pri parsiranju ${name}.json: ${e.message}`);
    return;
  }

  // očisti i uzmi sve base URL-ove
  const bases = (raw.TARGET_ADDON_BASES || [])
    .map(u => u.trim()
                .replace(/\/manifest\.json$/i, '')
                .replace(/\/+$/,''))
    .filter(Boolean);
  console.log(`🔗 [${name}] baze:`, bases);

  // fetch svakog manifesta
  const baseManifests = [];
  await Promise.all(bases.map(async b => {
    try {
      const r = await axios.get(`${b}/manifest.json`);
      if (r.data.catalogs) {
        baseManifests.push({ base: b, manifest: r.data });
      } else {
        console.warn(`⚠️  [${name}] ${b} nema catalogs`);
      }
    } catch (e) {
      console.warn(`⚠️  [${name}] ne mogu dohvatiti ${b}/manifest.json`);
    }
  }));

  if (!baseManifests.length) {
    console.error(`❌ [${name}] nema niti jedne validne baze → skip`);
    return;
  }

  configs[name] = { bases, baseManifests };

  // sklopi wrapper manifest (redoslijed kataloga onako kako ih baza listi)
  const ms = baseManifests.map(bm => bm.manifest);
  const wrapper = {
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
  wrapperManifests[name] = wrapper;
  console.log(`✅ [${name}] inicijalizirano: ${bases.length} baza, ${wrapper.catalogs.length} kataloga`);
}

// pokreni inicijalizaciju za sve config-e
Promise.all(configNames.map(initConfig))
  .then(() => console.log(`🎉 Svi configi spremni: ${configNames.join(', ')}`))
  .catch(err => {
    console.error('❌ Greška inicijalizacije configa:', err);
    process.exit(1);
  });

// ------------------------
// SERVERSKE RUTE
// ------------------------

// 1) manifest.json
app.get('/:conf/manifest.json', (req, res) => {
  const m = wrapperManifests[req.params.conf];
  if (!m) return res.status(404).json({ error: 'Config ne postoji' });
  return res.json(m);
});

// 2) POST /catalog  → spoji sve r.data.metas
app.post('/:conf/catalog', async (req, res) => {
  const cfg = configs[req.params.conf];
  if (!cfg) return res.json({ metas: [] });

  // filter za samo taj katalog
  const catalogId = req.body.id;
  const targets = cfg.baseManifests.filter(bm =>
    bm.manifest.catalogs.some(c=>c.id===catalogId)
  );
  if (!targets.length) return res.json({ metas: [] });

  console.log(`📦 [${req.params.conf}] POST /catalog → ${targets.length} baza`);
  const all = [];
  await Promise.all(targets.map(async bm => {
    try {
      const r = await axios.post(
        `${bm.base}/catalog`,
        req.body,
        { headers:{ 'Content-Type':'application/json' } }
      );
      if (Array.isArray(r.data.metas)) {
        all.push(...r.data.metas);
      }
    } catch(_){}
  }));
  return res.json({ metas: all });
});

// 3) POST /meta  → spoji sve r.data.meta ili r.data.metas
app.post('/:conf/meta', async (req, res) => {
  const cfg = configs[req.params.conf];
  if (!cfg) return res.json({ metas: [] });

  console.log(`ℹ️  [${req.params.conf}] POST /meta`);
  const all = [];
  await Promise.all(cfg.baseManifests.map(async bm => {
    try {
      const r = await axios.post(
        `${bm.base}/meta`,
        req.body,
        { headers:{ 'Content-Type':'application/json' }}
      );
      if (r.data.meta) all.push(r.data.meta);
      if (Array.isArray(r.data.metas)) all.push(...r.data.metas);
    } catch(_){}
  }));
  return res.json({ metas: all });
});

// 4) POST /stream  → spoji sve r.data.streams
app.post('/:conf/stream', async (req, res) => {
  const cfg = configs[req.params.conf];
  if (!cfg) return res.json({ streams: [] });

  console.log(`▶️  [${req.params.conf}] POST /stream`);
  const all = [];
  await Promise.all(cfg.baseManifests.map(async bm => {
    try {
      const r = await axios.post(
        `${bm.base}/stream`,
        req.body,
        { headers:{ 'Content-Type':'application/json' }}
      );
      if (Array.isArray(r.data.streams)) all.push(...r.data.streams);
    } catch(_){}
  }));
  return res.json({ streams: all });
});

// 5) POST /subtitles → spoji sve r.data.subtitles
app.post('/:conf/subtitles', async (req, res) => {
  const cfg = configs[req.params.conf];
  if (!cfg) return res.json({ subtitles: [] });

  console.log(`🔤 [${req.params.conf}] POST /subtitles`);
  const all = [];
  await Promise.all(cfg.baseManifests.map(async bm => {
    try {
      const r = await axios.post(
        `${bm.base}/subtitles`,
        req.body,
        { headers:{ 'Content-Type':'application/json' }}
      );
      if (Array.isArray(r.data.subtitles)) all.push(...r.data.subtitles);
    } catch(_){}
  }));
  return res.json({ subtitles: all });
});

// 6) fallback GET za V3 klijente
app.get('/:conf/:rest(*)', async (req, res) => {
  const cfg = configs[req.params.conf];
  if (!cfg) return res.status(404).json({ error:'Config ne postoji' });

  const p = req.params.rest;
  let key;
  if      (p.startsWith('catalog/'))    key='metas';
  else if (p.startsWith('stream/'))     key='streams';
  else if (p.startsWith('subtitles/'))  key='subtitles';
  else return res.status(404).json({ error:'Not found' });

  console.log(`🌐 GET /${req.params.conf}/${p}`);

  // za catalog, filtriraj po ID
  const parts = p.split('/');
  const id    = key==='metas' ? parts[2]?.replace('.json','') : null;

  const all = [];
  await Promise.all(cfg.baseManifests.map(async bm => {
    if (key==='metas' && !bm.manifest.catalogs.some(c=>c.id===id)) return;
    try {
      const r = await axios.get(`${bm.base}/${p}`, { headers: req.headers });
      if (Array.isArray(r.data[key])) all.push(...r.data[key]);
    } catch(_){}
  }));

  return res.json({ [key]: all });
});

// pokreni server
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
  console.log(`🔌 Listening on :${PORT}`);
});
