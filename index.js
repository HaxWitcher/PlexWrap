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

// Load and normalize target addon bases
let rawBases = [];
try {
  const cfg = JSON.parse(fs.readFileSync('./config.json'));
  rawBases = cfg.TARGET_ADDON_BASES;
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

// Load allowed API tokens from environment
const ALLOWED_TOKENS = (process.env.ACCESS_TOKENS || '')
  .split(',')
  .map(t => t.trim())
  .filter(Boolean);

if (!ALLOWED_TOKENS.length) {
  console.error('ACCESS_TOKENS not set or empty');
  process.exit(1);
}

// Middleware: require token for all endpoints via query param
app.use((req, res, next) => {
  const token = req.query.token;
  if (!token || !ALLOWED_TOKENS.includes(token)) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing token' });
  }
  next();
});

// Helper: broadcast GET to all addon bases
async function broadcastGet(path) {
  return Promise.all(
    bases.map(b =>
      axios.get(`${b}/${path}`)
        .then(r => r.data)
        .catch(() => null)
    )
  );
}

// Helper: broadcast POST to all addon bases
async function broadcastPost(path, body) {
  return Promise.all(
    bases.map(b =>
      axios.post(`${b}/${path}`, body, {
        headers: { 'Content-Type': 'application/json' }
      })
      .then(r => r.data)
      .catch(() => null)
    )
  );
}

// Build the wrapper manifest by fetching each addon manifest
async function buildWrapperManifest() {
  const results = await Promise.allSettled(
    bases.map(b => axios.get(`${b}/manifest.json`))
  );
  const manifests = results
    .map(r => (r.status === 'fulfilled' ? r.value.data : null))
    .filter(Boolean);
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
  const metas = responses.reduce((acc, r) =>
    (r && Array.isArray(r.metas) ? acc.concat(r.metas) : acc)
  , []);
  res.json({ metas });
});

app.post('/meta', async (req, res) => {
  const responses = await broadcastPost('meta', req.body);
  const metas = [];
  responses.forEach(r => {
    if (r?.meta) metas.push(r.meta);
    if (Array.isArray(r?.metas)) metas.push(...r.metas);
  });
  res.json({ metas });
});

app.post('/stream', async (req, res) => {
  const responses = await broadcastPost('stream', req.body);
  const streams = responses.reduce((acc, r) =>
    (r && Array.isArray(r.streams) ? acc.concat(r.streams) : acc)
  , []);
  res.json({ streams });
});

app.post('/subtitles', async (req, res) => {
  const responses = await broadcastPost('subtitles', req.body);
  const subtitles = responses.reduce((acc, r) =>
    (r && Array.isArray(r.subtitles) ? acc.concat(r.subtitles) : acc)
  , []);
  res.json({ subtitles });
});

// Catch-all GET proxy for V3 compatibility
app.get('*', async (req, res) => {
  const path = req.path.slice(1); // remove leading slash
  let key;
  if (path.startsWith('catalog/')) key = 'metas';
  else if (path.startsWith('stream/')) key = 'streams';
  else if (path.startsWith('subtitles/')) key = 'subtitles';
  else return res.status(404).json({ error: 'Not found' });

  const responses = await broadcastGet(path);
  const combined = responses.reduce((acc, r) =>
    (r && Array.isArray(r[key]) ? acc.concat(r[key]) : acc)
  , []);
  res.json({ [key]: combined });
});

// Start server
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
