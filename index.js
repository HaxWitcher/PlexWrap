const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Ensure working directory is correct
process.chdir(path.dirname(__filename));

const app = express();

// Enable CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// Load config files
const CONFIG_DIR = path.join(__dirname, 'configs');
const configs = {};
const wrapperManifests = {};

const configNames = fs.readdirSync(CONFIG_DIR)
  .filter(f => f.endsWith('.json'))
  .map(f => f.replace(/\.json$/, ''));

async function initConfig(name) {
  const cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, `${name}.json`)));
  const bases = (cfg.TARGET_ADDON_BASES || [])
    .map(u => u.trim().replace(/\/+$/, '').replace(/\/manifest\.json$/i, ''))
    .filter(Boolean);

  const baseManifests = [];
  await Promise.all(bases.map(async base => {
    try {
      const r = await axios.get(`${base}/manifest.json`);
      if (r.data.catalogs) baseManifests.push({ base, manifest: r.data });
    } catch {}
  }));

  configs[name] = { bases, baseManifests };

  const all = baseManifests.map(bm => bm.manifest);
  wrapperManifests[name] = {
    id: `stremio-proxy-wrapper-${name}`,
    version: '1.0.0',
    name: `Stremio Proxy Wrapper (${name})`,    
    description: 'Proxy svih vaših Stremio addon-a',
    resources: ['catalog','meta','stream','subtitles'],
    types: [...new Set(all.flatMap(m => m.types || []))],
    idPrefixes: [...new Set(all.flatMap(m => m.idPrefixes || []))],
    catalogs: all.flatMap(m => m.catalogs || []),
    logo: all[0]?.logo || '',
    icon: all[0]?.icon || ''
  };
  console.log(`Initialized config ${name}: ${wrapperManifests[name].catalogs.length} catalogs`);
}

Promise.all(configNames.map(initConfig))
  .then(() => console.log(`All configs ready: ${configNames.join(', ')}`))
  .catch(err => { console.error(err); process.exit(1); });

// Manifest endpoint
app.get('/:config/manifest.json', (req, res) => {
  const m = wrapperManifests[req.params.config];
  if (!m) return res.status(404).json({ error: 'Config not found' });
  res.json(m);
});

// Catalog handler (V4 POST -> V3 GET)
app.post('/:config/catalog', async (req, res) => {
  const cfg = configs[req.params.config];
  if (!cfg) return res.json({ metas: [] });
  const { type, id, extra = [] } = req.body;
  const qs = extra.map(e => `${encodeURIComponent(e.name)}=${encodeURIComponent(e.value)}`).join('&');
  const targets = cfg.baseManifests.filter(bm => bm.manifest.catalogs.some(c => c.id === id));
  let metas = [];
  await Promise.all(targets.map(async bm => {
    try {
      const url = `${bm.base}/catalog/${type}/${id}.json${qs ? '?' + qs : ''}`;
      const r = await axios.get(url);
      if (Array.isArray(r.data.metas)) metas.push(...r.data.metas);
    } catch {}
  }));
  res.json({ metas });
});

// Stream handler (POST -> GET V3)
app.post('/:config/stream', async (req, res) => {
  const cfg = configs[req.params.config];
  if (!cfg) return res.json({ streams: [] });
  const { type, id } = req.body;
  let streams = [];
  await Promise.all(cfg.baseManifests.map(async bm => {
    try {
      const url = `${bm.base}/stream/${type}/${id}.json`;
      const r = await axios.get(url);
      if (Array.isArray(r.data.streams)) streams.push(...r.data.streams);
    } catch {}
  }));
  res.json({ streams });
});

// Subtitles handler (POST -> GET V3)
app.post('/:config/subtitles', async (req, res) => {
  const cfg = configs[req.params.config];
  if (!cfg) return res.json({ subtitles: [] });
  const { type, id, extra = [] } = req.body;
  const qs = extra.map(e => `${encodeURIComponent(e.name)}=${encodeURIComponent(e.value)}`).join('&');
  let subs = [];
  await Promise.all(cfg.baseManifests.map(async bm => {
    try {
      const url = `${bm.base}/subtitles/${type}/${id}.json${qs ? '?' + qs : ''}`;
      const r = await axios.get(url);
      if (Array.isArray(r.data.subtitles)) subs.push(...r.data.subtitles);
    } catch {}
  }));
  res.json({ subtitles: subs });
});

// Fallback GET for any other v3 paths
app.get('/:config/:path(*)', async (req, res) => {
  const cfg = configs[req.params.config];
  if (!cfg) return res.status(404).json({ error: 'Config not found' });
  const key = req.params.path.split('/')[0];
  let listKey = key === 'catalog' ? 'metas' : key === 'stream' ? 'streams' : key === 'subtitles' ? 'subtitles' : null;
  if (!listKey) return res.status(404).json({ error: 'Not found' });
  const responses = await Promise.all(cfg.baseManifests.map(async bm => {
    try { return (await axios.get(`${bm.base}/${req.params.path}`, { headers: req.headers })).data; } catch { return null; }
  }));
  const combined = responses.reduce((acc, r) => { if (r && Array.isArray(r[listKey])) acc.push(...r[listKey]); return acc; }, []);
  res.json({ [listKey]: combined });
});

// Start server
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
