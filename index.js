const express = require('express');
const axios = require('axios');
const fs = require('fs');

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

// Load target addon bases from config.json or env var
let rawBases;
try {
  rawBases = JSON.parse(fs.readFileSync('./config.json')).TARGET_ADDON_BASES;
} catch (e) {
  console.error('Cannot load config.json:', e.message);
  process.exit(1);
}
if (process.env.TARGET_ADDON_BASES) {
  rawBases = process.env.TARGET_ADDON_BASES.split(',');
}
const bases = rawBases
  .map(u => u.trim().replace(/\/manifest\.json$/i, '').replace(/\/+$/, ''))
  .filter(Boolean);
if (!bases.length) {
  console.error('No valid TARGET_ADDON_BASES provided');
  process.exit(1);
}

// Fetch and store each base's manifest
const baseManifests = [];
async function initBaseManifests() {
  const results = await Promise.allSettled(
    bases.map(b => axios.get(`${b}/manifest.json`))
  );
  results.forEach((r, idx) => {
    if (r.status === 'fulfilled' && r.value.data.catalogs) {
      baseManifests.push({ base: bases[idx], manifest: r.value.data });
    }
  });
  if (!baseManifests.length) {
    console.error('No valid addon manifests fetched');
    process.exit(1);
  }
  console.log(`Loaded ${baseManifests.length} addon manifests`);
}

// Initialize manifests
initBaseManifests().then(() => console.log('Base manifests ready'));

// Build wrapper manifest
function buildWrapperManifest() {
  const manifests = baseManifests.map(bm => bm.manifest);
  return {
    id: 'stremio-proxy-wrapper',
    version: '1.0.0',
    name: 'Stremio Proxy Wrapper',
    description: 'Proxy svih vaših Stremio addon-a',
    resources: ['catalog','meta','stream','subtitles'],
    types: [...new Set(manifests.flatMap(m => m.types || []))],
    idPrefixes: [...new Set(manifests.flatMap(m => m.idPrefixes || []))],
    catalogs: manifests.flatMap(m => m.catalogs || []),
    logo: manifests[0].logo || '',
    icon: manifests[0].icon || ''
  };
}
let wrapperManifest;
setTimeout(() => {
  wrapperManifest = buildWrapperManifest();
  console.log(`Wrapper manifest built with ${wrapperManifest.catalogs.length} catalogs`);
}, 1000);

// Serve manifest
app.get('/manifest.json', (req, res) => {
  if (!wrapperManifest) return res.status(503).json({ error: 'Manifest not ready' });
  res.json(wrapperManifest);
});

// Catalog
app.post('/catalog', async (req, res) => {
  const catalogId = req.body.id;
  const targets = baseManifests
    .filter(bm => bm.manifest.catalogs.some(c => c.id === catalogId))
    .map(bm => bm.base);
  if (!targets.length) return res.json({ metas: [] });

  const responses = await Promise.all(
    targets.map(b =>
      axios.post(`${b}/catalog`, req.body, { headers: {'Content-Type':'application/json'} })
        .then(r => r.data)
        .catch(() => null)
    )
  );
  const metas = responses.reduce(
    (acc, r) => (r && Array.isArray(r.metas) ? acc.concat(r.metas) : acc),
    []
  );
  res.json({ metas });
});

// Meta
app.post('/meta', async (req, res) => {
  const responses = await Promise.all(
    baseManifests.map(bm =>
      axios.post(`${bm.base}/meta`, req.body, { headers: {'Content-Type':'application/json'} })
        .then(r => r.data)
        .catch(() => null)
    )
  );
  const metas = [];
  responses.forEach(r => {
    if (r?.meta) metas.push(r.meta);
    if (Array.isArray(r?.metas)) metas.push(...r.metas);
  });
  res.json({ metas });
});

// Stream
app.post('/stream', async (req, res) => {
  const responses = await Promise.all(
    baseManifests.map(bm =>
      axios.post(`${bm.base}/stream`, req.body, { headers: {'Content-Type':'application/json'} })
        .then(r => r.data)
        .catch(() => null)
    )
  );
  const streams = responses.reduce(
    (acc, r) => (r && Array.isArray(r.streams) ? acc.concat(r.streams) : acc),
    []
  );
  res.json({ streams });
});

// Subtitles
app.post('/subtitles', async (req, res) => {
  const responses = await Promise.all(
    baseManifests.map(bm =>
      axios.post(`${bm.base}/subtitles`, req.body, { headers: {'Content-Type':'application/json'} })
        .then(r => r.data)
        .catch(() => null)
    )
  );
  const subtitles = responses.reduce(
    (acc, r) => (r && Array.isArray(r.subtitles) ? acc.concat(r.subtitles) : acc),
    []
  );
  res.json({ subtitles });
});

// GET fallback for V3
app.get('*', async (req, res) => {
  const path = req.path.slice(1);
  let key;
  if (path.startsWith('catalog/')) key = 'metas';
  else if (path.startsWith('stream/')) key = 'streams';
  else if (path.startsWith('subtitles/')) key = 'subtitles';
  else return res.status(404).json({ error: 'Not found' });

  let targets = bases;
  if (key === 'metas') {
    const parts = path.split('/');
    const id = parts[2]?.replace('.json','');
    targets = baseManifests
      .filter(bm => bm.manifest.catalogs.some(c => c.id === id))
      .map(bm => bm.base);
  }

  const responses = await Promise.all(
    targets.map(b =>
      axios.get(`${b}/${path}`)
        .then(r => r.data)
        .catch(() => null)
    )
  );
  const combined = responses.reduce(
    (acc, r) => (r && Array.isArray(r[key]) ? acc.concat(r[key]) : acc),
    []
  );
  res.json({ [key]: combined });
});

// Start server
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
