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

// Load TARGET_ADDON_BASES from config or env
let rawBases = [];
try {
  const cfg = JSON.parse(fs.readFileSync('./config.json'));
  rawBases = cfg.TARGET_ADDON_BASES;
} catch (e) {
  console.error('Cannot load config.json:', e.message);
  process.exit(1);
}
if (process.env.TARGET_ADDON_BASES) rawBases = process.env.TARGET_ADDON_BASES.split(',');

// Normalize base URLs
const bases = rawBases
  .map(u => u.trim())
  .map(u => u.replace(/\/manifest\.json$/i, ''))
  .map(u => u.replace(/\/+$/, ''))
  .filter(u => u);
if (bases.length === 0) {
  console.error('No valid TARGET_ADDON_BASES provided');
  process.exit(1);
}

// Broadcast GET helper
async function broadcastGet(path) {
  const calls = bases.map(b =>
    axios.get(`${b}/${path}`)
      .then(r => r.data)
      .catch(() => null)
  );
  return Promise.all(calls);
}

// Broadcast POST helper
async function broadcastPost(path, body) {
  const calls = bases.map(b =>
    axios.post(`${b}/${path}`, body, { headers: { 'Content-Type': 'application/json' } })
      .then(r => r.data)
      .catch(() => null)
  );
  return Promise.all(calls);
}

// Build wrapper manifest
async function buildWrapperManifest() {
  const results = await Promise.allSettled(bases.map(b => axios.get(`${b}/manifest.json`)));
  const manifests = results.map(r => r.status === 'fulfilled' ? r.value.data : null).filter(Boolean);
  if (!manifests.length) {
    console.error('No valid manifests fetched');
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

let wrapperManifest;
buildWrapperManifest().then(m => {
  wrapperManifest = m;
  console.log(`Wrapper manifest built with ${m.catalogs.length} catalog entries`);
}).catch(e => {
  console.error('Error building manifest:', e.message);
  process.exit(1);
});

// Serve manifest
app.get('/manifest.json', (req, res) => {
  if (!wrapperManifest) return res.status(503).json({ error: 'Manifest not ready' });
  res.json(wrapperManifest);
});

// V4 endpoints
app.post('/catalog', async (req, res) => {
  const responses = await broadcastPost('catalog', req.body);
  const metas = responses.reduce((acc, r) => (r && Array.isArray(r.metas) ? acc.concat(r.metas) : acc), []);
  res.json({ metas });
});
app.post('/meta', async (req, res) => {
  const responses = await broadcastPost('meta', req.body);
  const metas = [];
  responses.forEach(r => {
    if (r && r.meta) metas.push(r.meta);
    if (r && Array.isArray(r.metas)) metas.push(...r.metas);
  });
  res.json({ metas });
});
app.post('/stream', async (req, res) => {
  const responses = await broadcastPost('stream', req.body);
  const streams = responses.reduce((acc, r) => (r && Array.isArray(r.streams) ? acc.concat(r.streams) : acc), []);
  res.json({ streams });
});
app.post('/subtitles', async (req, res) => {
  const responses = await broadcastPost('subtitles', req.body);
  const subs = responses.reduce((acc, r) => (r && Array.isArray(r.subtitles) ? acc.concat(r.subtitles) : acc), []);
  res.json({ subtitles: subs });
});

// Catch-all GET proxy for V3 compatibility
app.get('*', async (req, res) => {
  const urlPath = req.path;
  let key;
  if (urlPath.startsWith('/catalog/')) key = 'metas';
  else if (urlPath.startsWith('/stream/')) key = 'streams';
  else if (urlPath.startsWith('/subtitles/')) key = 'subtitles';
  else return res.status(404).json({ error: 'Not found' });

  const path = urlPath.slice(1); // remove leading slash
  const responses = await broadcastGet(path);
  const combined = responses.reduce((acc, r) => (r && Array.isArray(r[key]) ? acc.concat(r[key]) : acc), []);
  res.json({ [key]: combined });
});

// Start server
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
