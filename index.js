const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Ensure working directory is always the folder containing this script
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
// Stores loaded configs and manifests
const configs = {};          // configName -> { bases, baseManifests }
const wrapperManifests = {}; // configName -> wrapper manifest JSON

// Discover available config names (file names without .json)
const configNames = fs.readdirSync(CONFIG_DIR)
  .filter(f => f.endsWith('.json'))
  .map(f => f.replace(/\.json$/, ''));

// Load and initialize one config
async function initConfig(configName) {
  const cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, `${configName}.json`)));
  let rawBases = cfg.TARGET_ADDON_BASES || [];
  const bases = rawBases
    .map(u => u.trim().replace(/\/+$/,'').replace(/\/manifest\.json$/i,''))
    .filter(Boolean);

  // Fetch each base's manifest
  const baseManifests = [];
  const results = await Promise.allSettled(
    bases.map(b => axios.get(`${b}/manifest.json`))
  );
  results.forEach((r, idx) => {
    if (r.status === 'fulfilled' && r.value.data.catalogs) {
      baseManifests.push({ base: bases[idx], manifest: r.value.data });
    }
  });
  if (!baseManifests.length) console.error(`! No valid manifests for config: ${configName}`);
  configs[configName] = { bases, baseManifests };

  // Build wrapper manifest for this config
  const manifests = baseManifests.map(bm => bm.manifest);
  const wrapper = {
    id: `stremio-proxy-wrapper-${configName}`,
    version: '1.0.0',
    name: `Stremio Proxy Wrapper (${configName})`, // differentiate name
    description: 'Proxy svih vaših Stremio addon-a',
    resources: ['catalog','meta','stream','subtitles'],
    types: [...new Set(manifests.flatMap(m => m.types || []))],
    idPrefixes: [...new Set(manifests.flatMap(m => m.idPrefixes || []))],
    catalogs: manifests.flatMap(m => m.catalogs || []),
    logo: manifests[0]?.logo || '',
    icon: manifests[0]?.icon || ''
  };
  wrapperManifests[configName] = wrapper;
  console.log(`Initialized config ${configName}: ${wrapper.catalogs.length} catalogs`);
}

// Initialize all configs
Promise.all(configNames.map(initConfig))
  .then(() => console.log(`All configs ready: ${configNames.join(', ')}`))
  .catch(err => {
    console.error('Error initializing configs:', err);
    process.exit(1);
  });

// Serve manifest per config
app.get('/:config/manifest.json', (req, res) => {
  const conf = req.params.config;
  const manifest = wrapperManifests[conf];
  if (!manifest) return res.status(404).json({ error: 'Config not found' });
  res.json(manifest);
});

// Generic handler factory for POST endpoints
function makePostHandler(key) {
  return async (req, res) => {
    const conf = req.params.config;
    const cfg = configs[conf];
    if (!cfg) return res.json({ [key]: [] });

    let targets = cfg.baseManifests;
    // For catalog, filter by requested catalog id
    if (key === 'metas') {
      const catalogId = req.body.id;
      targets = cfg.baseManifests.filter(bm => bm.manifest.catalogs.some(c => c.id === catalogId));
    }
    if (!targets.length) return res.json({ [key]: [] });

    // Proxy all requests
    const responses = await Promise.all(
      targets.map(bm =>
        axios.post(`${bm.base}/${key === 'metas' ? 'catalog' : key}`, req.body, { headers: {'Content-Type':'application/json'} })
          .then(r => r.data)
          .catch(() => null)
      )
    );

    // Combine arrays
    const combined = responses.reduce((acc, r) => {
      if (r && Array.isArray(r[key])) acc.push(...r[key]);
      return acc;
    }, []);
    res.json({ [key]: combined });
  };
}
app.post('/:config/catalog', makePostHandler('metas'));
app.post('/:config/meta', makePostHandler('metas'));
app.post('/:config/stream', makePostHandler('streams'));
app.post('/:config/subtitles', makePostHandler('subtitles'));

// Fallback GET for V3 compatibility
app.get('/:config/:path(*)', async (req, res) => {
  const conf = req.params.config;
  const cfg = configs[conf];
  if (!cfg) return res.status(404).json({ error: 'Config not found' });

  const pathKey = req.params.path;
  let key;
  if (pathKey.startsWith('catalog/')) key = 'metas';
  else if (pathKey.startsWith('stream/')) key = 'streams';
  else if (pathKey.startsWith('subtitles/')) key = 'subtitles';
  else return res.status(404).json({ error: 'Not found' });

  let targets = cfg.baseManifests;
  if (key === 'metas') {
    const parts = pathKey.split('/');
    const id = parts[2]?.replace('.json','');
    targets = cfg.baseManifests.filter(bm => bm.manifest.catalogs.some(c => c.id === id));
  }

  const responses = await Promise.all(
    targets.map(bm =>
      axios.get(`${bm.base}/${pathKey}`, { headers: req.headers })
        .then(r => r.data)
        .catch(() => null)
    )
  );
  const combined = responses.reduce((acc, r) => {
    if (r && Array.isArray(r[key])) acc.push(...r[key]);
    return acc;
  }, []);
  res.json({ [key]: combined });
});

// Start server
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
