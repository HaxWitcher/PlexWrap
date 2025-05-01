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

// Folder s config fajlovima (configA.json, configB.json …)
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

const configs         = {}; // ime -> { bases, baseManifests }
const wrapperManifests = {};// ime -> manifest JSON

// inicijalizacija jednog configa
async function initConfig(name) {
  const file = path.join(CONFIG_DIR, `${name}.json`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`❌ Greška pri parsiranju ${name}.json: ${e.message}`);
    return;
  }
  const bases = (raw.TARGET_ADDON_BASES||[])
    .map(u => u.trim().replace(/\/manifest\.json$/i,'').replace(/\/+$/,''))
    .filter(Boolean);
  console.log(`🔗 [${name}] baze:`, bases);

  const baseManifests = [];
  await Promise.all(bases.map(async b => {
    try {
      const r = await axios.get(`${b}/manifest.json`);
      if (r.data.catalogs) baseManifests.push({ base: b, manifest: r.data });
      else console.warn(`⚠️ [${name}] ${b} nema catalogs`);
    } catch (_) {
      console.warn(`⚠️ [${name}] ne mogu dohvatiti manifest from ${b}`);
    }
  }));

  if (!baseManifests.length) {
    console.error(`❌ [${name}] nema validnih baza → skip`);
    return;
  }

  configs[name] = { bases, baseManifests };
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

Promise.all(configNames.map(initConfig))
  .then(() => console.log(`🎉 Svi configi spremni: ${configNames.join(', ')}`))
  .catch(err => { console.error(err); process.exit(1); });

// SERVISNE RUTE:

// manifest.json za svaki config
app.get('/:conf/manifest.json', (req,res) => {
  const m = wrapperManifests[req.params.conf];
  if (!m) return res.status(404).json({ error:'Config ne postoji' });
  res.json(m);
});

// POST v4:
['catalog','meta','stream','subtitles'].forEach(key=>{
  const endpoint = key;
  const resultKey = key === 'catalog' || key==='meta' ? 'metas': key;
  app.post(`/:conf/${endpoint}`, async (req,res)=>{
    const cfg = configs[req.params.conf];
    if(!cfg) return res.json({ [resultKey]: [] });

    // specijalno za catalog: filter by id
    let targets = cfg.baseManifests;
    if (endpoint==='catalog') {
      const id = req.body.id;
      targets = targets.filter(bm=>bm.manifest.catalogs.some(c=>c.id===id));
    }

    console.log(`📦 [${req.params.conf}] POST /${endpoint} → ${targets.length} baza`);
    const all = [];
    await Promise.all(targets.map(async bm=>{
      try{
        const r = await axios.post(
          `${bm.base}/${endpoint}`,
          req.body,
          { headers:{ 'Content-Type':'application/json' }}
        );
        const arr = r.data[resultKey]||[];
        if(Array.isArray(arr)) all.push(...arr);
      }catch(_){/*noop*/}
    }));
    res.json({ [resultKey]: all });
  });
});

// GET fallback za legacy v3 GET endpoints:
// 1) katalogi
app.get('/:conf/catalog/:type/:id.json', async (req,res) => {
  const cfg = configs[req.params.conf];
  if(!cfg) return res.status(404).json({ metas:[] });
  const id   = req.params.id.replace(/\.json$/,'');
  const type = req.params.type;
  const body = { id, type, extra:{} };
  if(req.query.genre) body.extra.genre = req.query.genre;
  if(req.query.skip ) body.extra.skip  = parseInt(req.query.skip)||0;

  // filter baze
  const targets = cfg.baseManifests.filter(bm=>
    bm.manifest.catalogs.some(c=>c.id===id)
  );
  console.log(`📦 [${req.params.conf}] GET /catalog/${type}/${id}.json → POST /catalog → ${targets.length}`);
  const metas = [];
  for(const bm of targets){
    try{
      const r = await axios.post(
        `${bm.base}/catalog`,
        body,
        { headers:{ 'Content-Type':'application/json' }}
      );
      if(Array.isArray(r.data.metas)) metas.push(...r.data.metas);
    }catch(_){/*noop*/}
  }
  res.json({ metas });
});

// 2) stream
app.get('/:conf/stream/:type/:id.json', async (req,res) => {
  const cfg = configs[req.params.conf];
  if(!cfg) return res.status(404).json({ streams:[] });
  const type = req.params.type;
  const id   = req.params.id;
  const qs   = req.url.includes('?') ? req.url.split('?')[1] : '';

  console.log(`▶️  [${req.params.conf}] GET /stream/${type}/${id}.json`);
  const streams = [];
  for(const bm of cfg.baseManifests){
    try{
      const url = `${bm.base}/stream/${type}/${id}.json${qs?'?'+qs:''}`;
      const r   = await axios.get(url, { headers:req.headers });
      if(Array.isArray(r.data.streams)) streams.push(...r.data.streams);
    }catch(_){/*noop*/}
  }
  res.json({ streams });
});

// 3) subtitles
app.get('/:conf/subtitles/:type/:id.json', async (req,res) => {
  const cfg = configs[req.params.conf];
  if(!cfg) return res.status(404).json({ subtitles:[] });
  const type = req.params.type;
  const id   = req.params.id;
  const qs   = req.url.includes('?') ? req.url.split('?')[1] : '';

  console.log(`🔤 [${req.params.conf}] GET /subtitles/${type}/${id}.json`);
  const subs = [];
  for(const bm of cfg.baseManifests){
    try{
      const url = `${bm.base}/subtitles/${type}/${id}.json${qs?'?'+qs:''}`;
      const r   = await axios.get(url, { headers:req.headers });
      if(Array.isArray(r.data.subtitles)) subs.push(...r.data.subtitles);
    }catch(_){/*noop*/}
  }
  res.json({ subtitles: subs });
});

// start server
const PORT = process.env.PORT||7000;
app.listen(PORT,()=> console.log(`🔌 Listening on :${PORT}`));
