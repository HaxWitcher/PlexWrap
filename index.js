const express = require('express');
const axios = require('axios');
const fs = require('fs');
const app = express();

// CORS middleware for Stremio
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// Load target addon bases from config or environment
let rawBases = [];
try {
  const cfg = JSON.parse(fs.readFileSync('./config.json'));
  rawBases = cfg.TARGET_ADDON_BASES;
} catch (e) {
  console.error('Cannot load config.json:', e.message);
  process.exit(1);
}
if (process.env.TARGET_ADDON_BASES) rawBases = process.env.TARGET_ADDON_BASES.split(',');

// Normalize base URLs: remove manifest.json and trailing slashes
const bases = rawBases
  .map(u => u.trim())
  .map(u => u.replace(/\/manifest\.json$/i, ''))
  .map(u => u.replace(/\/+$/, ''))
  .filter(u => u);

if (bases.length === 0) {
  console.error('No valid TARGET_ADDON_BASES provided');
  process.exit(1);
}

// Helper: proxy GET to each base
async function broadcastGet(path) {
  console.log(`Proxy GET path: ${path}`);
  const calls = bases.map(b =>
    axios.get(`${b}/${path}`)
      .then(r => r.data)
      .catch(err => {
        console.warn(`GET ${path} failed for ${b}: ${err.message}`);
        return null;
      })
  );
  return Promise.all(calls);
}

// Helper: proxy POST to each base
async function broadcastPost(path, body) {
  console.log(`Proxy POST path: ${path}, body:`, body);
  const calls = bases.map(b =>
    axios.post(`${b}/${path}`, body, { headers: { 'Content-Type': 'application/json' } })
      .then(r => r.data)
      .catch(err => {
        console.warn(`POST ${path} failed for ${b}: ${err.message}`);
        return null;
      })
  );
  return Promise.all(calls);
}

// Build wrapper manifest by fetching each addon's manifest.json
async function buildWrapperManifest() {
  const results = await Promise.allSettled(bases.map(b => axios.get(`${b}/manifest.json`)));
  const manifests = results.map(r => (r.status === 'fulfilled' ? r.value.data : null)).filter(m => m);
  if (manifests.length === 0) {
    console.error('No valid manifests fetched, aborting');
    process.exit(1);
  }
  return {
    id: 'stremio-proxy-wrapper',
    version: '1.0.0',
    name: 'Stremio Proxy Wrapper',
    description: 'Proxy svih vaših Stremio addon-a',
    resources: ['catalog', 'meta', 'stream', 'subtitles'],
    types: [...new Set(manifests.flatMap(m => m.types || []))],
    idPrefixes: [...new Set(manifests.flatMap(m => m.idPrefixes || []))],
    catalogs: manifests.flatMap(m => m.catalogs || []),
    logo: manifests[0].logo || '',
    icon: manifests[0].icon || ''
  };
}

// Initialize wrapper manifest
let wrapperManifest;
buildWrapperManifest()
  .then(man => {
    wrapperManifest = man;
    console.log(`Wrapper manifest built with ${man.catalogs.length} catalog entries`);
  })
  .catch(err => {
    console.error('Error building manifest:', err.message);
    process.exit(1);
  });

// Serve manifest.json
app.get('/manifest.json', (req, res) => {
  if (!wrapperManifest) {
    return res.status(503).json({ error: 'Manifest not ready' });
  }
  res.json(wrapperManifest);
});

// V4 endpoints
app.post('/catalog', async (req, res) => {
  const responses = await broadcastPost('catalog', req.body);
  const metas = responses.reduce((a, r) => (r && Array.isArray(r.metas) ? a.concat(r.metas) : a), []);
  res.json({ metas });
});
app.post('/meta', async (req, res) => {
  const responses = await broadcastPost('meta', req.body);
  const metas = [];
  responses.forEach(r => {
    if (!r) return;
    if (r.meta) metas.push(r.meta);
    if (Array.isArray(r.metas)) metas.push(...r.metas);
  });
  res.json({ metas });
});
app.post('/stream', async (req, res) => {
  const responses = await broadcastPost('stream', req.body);
  const streams = responses.reduce((a, r) => (r && Array.isArray(r.streams) ? a.concat(r.streams) : a), []);
  res.json({ streams });
});
app.post('/subtitles', async (req, res) => {
  const responses = await broadcastPost('subtitles', req.body);
  const subs = responses.reduce((a, r) => (r && Array.isArray(r.subtitles) ? a.concat(r.subtitles) : a), []);
  res.json({ subtitles: subs });
});

// Catch-all GET proxy for V3 compatibility (handles catalog, stream, subtitles)
app.get('/*', async (req, res) => {
  const path = req.path.replace(/^\//, '');
  const responses = await broadcastGet(path);
  const key = /\/catalog\//.test(path)
    ? 'metas'
    : /\/stream\//.test(path)
    ? 'streams'
    : /\/subtitles\//.test(path)
    ? 'subtitles'
    : null;
  if (!key) {
    return res.status(404).json({ error: 'Not found' });
  }
  const combined = responses.reduce((a, r) => (r && Array.isArray(r[key]) ? a.concat(r[key]) : a), []);
  res.json({ [key]: combined });
});

// Start server
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
