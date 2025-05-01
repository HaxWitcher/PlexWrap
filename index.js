const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Ensure working directory is the folder containing this script
process.chdir(path.dirname(__filename));

const app = express();

// Enable CORS for Stremio
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// Directory containing multiple config files named {configName}.json
const CONFIG_DIR = path.join(__dirname, 'configs');
const configs = {};          // configName -> { bases, baseManifests }
const wrapperManifests = {}; // configName -> wrapper manifest JSON

// Discover available config names (files without .json)
let configNames;
try {
  configNames = fs.readdirSync(CONFIG_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''));
} catch (err) {
  console.error(`Failed to read configs directory: ${err.message}`);
  process.exit(1);
}

// Initialize a config: load bases, fetch manifests, build wrapper
async function initConfig(configName) {
  const cfgFile = path.join(CONFIG_DIR, `${configName}.json`);
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgFile));
  } catch (e) {
    console.error(`Error parsing ${cfgFile}: ${e.message}`);
    return;
  }

  const bases = (cfg.TARGET_ADDON_BASES || [])
    .map(u => u.trim().replace(/\/+$/, '').replace(/\/manifest\.json$/i, ''))
    .filter(Boolean);

  const baseManifests = [];
  await Promise.all(
    bases.map(async base => {
      try {
        const res = await axios.get(`${base}/manifest.json`);
        if (res.data.catalogs) baseManifests.push({ base, manifest: res.data });
      } catch {}
    })
  );

  configs[configName] = { bases, baseManifests };

  // Build wrapper manifest
  const manifests = baseManifests.map(bm => bm.manifest);
  wrapperManifests[configName] = {
    id: `stremio-proxy-wrapper-${configName}`,
    version: '1.0.0',
    name: `Stremio Proxy Wrapper (${configName})`, // differentiate
    description: 'Proxy svih vaših Stremio addon-a',
    resources: ['catalog', 'meta', 'stream', 'subtitles'],
    types: [...new Set(manifests.flatMap(m => m.types || []))],
    idPrefixes: [...new Set(manifests.flatMap(m => m.idPrefixes || []))],
    catalogs: manifests.flatMap(m => m.catalogs || []),
    logo: manifests[0]?.logo || '',
    icon: manifests[0]?.icon || ''
  };

  console.log(`Initialized config ${configName}: ${manifests.length} base addons`);
}

// Load all configs
Promise.all(configNames.map(initConfig))
  .then(() => console.log(`All configs ready: ${configNames.join(', ')}`))
  .catch(err => {
    console.error('Error initializing configs:', err);
    process.exit(1);
  });

// Serve wrapper manifest per config
app.get('/:config/manifest.json', (req, res) => {
  const manifest = wrapperManifests[req.params.config];
  if (!manifest) return res.status(404).json({ error: 'Config not found' });
  res.json(manifest);
});

// Generic V4 POST handler converting to V3 GET
async function handleV4(req, res, listKey, v3path) {
  const configName = req.params.config;
  const cfg = configs[configName];
  if (!cfg) return res.json({ [listKey]: [] });

  // Determine targets
  let targets = cfg.baseManifests;
  if (listKey === 'metas') {
    const id = req.body.id;
    targets = targets.filter(bm => bm.manifest.catalogs.some(c => c.id === id));
  }

  // For 'catalog' or 'subtitles', support extra params
  const qs = req.body.extra
    ? '?' + req.body.extra.map(e => `${encodeURIComponent(e.name)}=${encodeURIComponent(e.value)}`).join('&')
    : '';

  const items = [];
  await Promise.all(
    targets.map(async bm => {
      try {
        const url = `${bm.base}/${v3path}/${req.body.type}/${
          listKey === 'metas' ? req.body.id : req.body.id
        }.json${qs}`;
        const r = await axios.get(url);
        if (Array.isArray(r.data[listKey])) items.push(...r.data[listKey]);
      } catch {}
    })
  );

  res.json({ [listKey]: items });
}

app.post('/:config/catalog', (req, res) => handleV4(req, res, 'metas', 'catalog'));
app.post('/:config/stream', (req, res) => handleV4(req, res, 'streams', 'stream'));
app.post('/:config/subtitles', (req, res) => handleV4(req, res, 'subtitles', 'subtitles'));
app.post('/:config/meta', (req, res) => handleV4(req, res, 'metas', 'meta'));

// Fallback GET for V3 routes
app.get('/:config/:path(*)', async (req, res) => {
  const configName = req.params.config;
  const cfg = configs[configName];
  if (!cfg) return res.status(404).json({ error: 'Config not found' });

  const p = req.params.path;
  let listKey;
  if (p.startsWith('catalog/')) listKey = 'metas';
  else if (p.startsWith('stream/')) listKey = 'streams';
  else if (p.startsWith('subtitles/')) listKey = 'subtitles';
  else return res.status(404).json({ error: 'Not found' });

  const parts = p.split('/');
  const id = listKey === 'metas' ? parts[2].replace('.json', '') : null;

  const items = [];
  await Promise.all(
    cfg.baseManifests.map(async bm => {
      if (listKey === 'metas' && !bm.manifest.catalogs.some(c => c.id === id)) return;
      try {
        const r = await axios.get(`${bm.base}/${p}`, { headers: req.headers });
        if (Array.isArray(r.data[listKey])) items.push(...r.data[listKey]);
      } catch {}
    })
  );

  res.json({ [listKey]: items });
});

// Start server
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
