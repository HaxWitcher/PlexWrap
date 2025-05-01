// index.js
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Ensure we run in the script directory
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

// Directory for per-config JSON files: configA.json, configB.json, ...
const CONFIG_DIR = path.join(__dirname, 'configs');
const configs = {};          // configName -> { bases, baseManifests }
const wrapperManifests = {}; // configName -> wrapper manifest JSON

// Discover available config names
let configNames = [];
try {
  configNames = fs.readdirSync(CONFIG_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''));
} catch (err) {
  console.error('Error reading configs folder:', err);
  process.exit(1);
}

// Initialize a single config: load bases, fetch each manifest, build wrapper
async function initConfig(configName) {
  const cfgPath = path.join(CONFIG_DIR, `${configName}.json`);
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath));
  } catch (e) {
    console.error(`Cannot load ${configName}.json:`, e.message);
    return;
  }

  const rawBases = cfg.TARGET_ADDON_BASES || [];
  const bases = rawBases
    .map(u => u.trim()
      .replace(/\/+$/, '')
      .replace(/\/manifest\.json$/i, ''))
    .filter(Boolean);

  const baseManifests = [];
  const results = await Promise.allSettled(
    bases.map(b => axios.get(`${b}/manifest.json`))
  );
  results.forEach((r, idx) => {
    if (r.status === 'fulfilled' && r.value.data.catalogs) {
      baseManifests.push({ base: bases[idx], manifest: r.value.data });
    } else {
      console.warn(`[${configName}] Failed to fetch ${bases[idx]}/manifest.json`);
    }
  });
  if (!baseManifests.length) {
    console.error(`! No valid manifests for config: ${configName}`);
  }
  configs[configName] = { bases, baseManifests };

  const manifests = baseManifests.map(bm => bm.manifest);
  // Build wrapper manifest including manifestVersion: '4'
  const wrapper = {
    manifestVersion: '4',
    id: `stremio-proxy-wrapper-${configName}`,
    version: '1.0.0',
    name: `Stremio Proxy Wrapper (${configName})`,  // differentiate by config
    description: 'Proxy svih vaših Stremio addon-a',
    resources: ['catalog', 'meta', 'stream', 'subtitles'],
    types: [...new Set(manifests.flatMap(m => m.types || []))],
    idPrefixes: [...new Set(manifests.flatMap(m => m.idPrefixes || []))],
    catalogs: manifests.flatMap(m => m.catalogs || []),
    logo: manifests[0]?.logo || '',
    icon: manifests[0]?.icon || ''
  };
  wrapperManifests[configName] = wrapper;
  console.log(`✅ [${configName}] inicijalizirano: ${bases.length} baza, ${wrapper.catalogs.length} katalog stavki`);
}

// Initialize all configs in parallel
(async () => {
  await Promise.all(configNames.map(initConfig));
  console.log(`🎉 Svi configi spremni: ${configNames.join(', ')}`);
})();

// Serve wrapper manifest per config
app.get('/:config/manifest.json', (req, res) => {
  const conf = req.params.config;
  const manifest = wrapperManifests[conf];
  if (!manifest) return res.status(404).json({ error: 'Config not found' });
  res.json(manifest);
});

// Generic POST handler factory (catalog/meta/stream/subtitles)
function makePostHandler(key) {
  return async (req, res) => {
    const conf = req.params.config;
    const cfg = configs[conf];
    if (!cfg) return res.json({ [key]: [] });

    let targets = cfg.baseManifests;
    if (key === 'metas') {
      const catalogId = req.body.id;
      targets = targets.filter(bm => bm.manifest.catalogs.some(c => c.id === catalogId));
    }
    if (!targets.length) return res.json({ [key]: [] });

    const responses = await Promise.all(
      targets.map(bm =>
        axios.post(
          `${bm.base}/${key === 'metas' ? 'catalog' : key}`,
          req.body,
          { headers: { 'Content-Type': 'application/json' } }
        )
          .then(r => r.data)
          .catch(() => null)
      )
    );
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
    const cid = parts[2]?.replace('.json', '');
    targets = targets.filter(bm => bm.manifest.catalogs.some(c => c.id === cid));
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

// Start HTTP server\const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`🔌 Listening on :${PORT}`));
