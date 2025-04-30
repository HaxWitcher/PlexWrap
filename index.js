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

// Load target addon bases from config or env
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

// Normalize bases: strip '/manifest.json' and trailing slashes
const bases = rawBases
  .map(b => b.trim())
  .map(u => u.endsWith('/manifest.json') ? u.slice(0, -'/manifest.json'.length) : u)
  .map(u => u.replace(/\/+$/, ''))
  .filter(u => u);

if (bases.length === 0) {
  console.error('No valid TARGET_ADDON_BASES provided');
  process.exit(1);
}

// Build wrapper manifest from all fetched manifests
async function buildWrapperManifest() {
  const results = await Promise.allSettled(
    bases.map(b => axios.get(`${b}/manifest.json`))
  );
  const manifests = results
    .map((r, i) => r.status === 'fulfilled' ? r.value.data : null)
    .filter(m => m);
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

// Serve manifest
app.get('/manifest.json', (req, res) => {
  if (!wrapperManifest) return res.status(503).json({ error: 'Manifest not ready' });
  res.json(wrapperManifest);
});

// POST proxy helper (V4)
async function broadcastPost(path, body) {
  return Promise.all(
    bases.map(b =>
      axios
        .post(`${b}/${path}`, body, { headers: { 'Content-Type': 'application/json' } })
        .then(r => r.data)
        .catch(err => {
          console.warn(`POST ${path} failed for ${b}: ${err.message}`);
          return null;
        })
    )
  );
}

// GET proxy helper (V3)
async function broadcastGet(path) {
  return Promise.all(
    bases.map(b =>
      axios
        .get(`${b}/${path}`)
        .then(r => r.data)
        .catch(err => {
          console.warn(`GET ${path} failed for ${b}: ${err.message}`);
          return null;
        })
    )
  );
}

// Catalog V4
app.post('/catalog', async (req, res) => {
  const responses = await broadcastPost('catalog', req.body);
  console.log('Catalog raw responses:', responses);
  const metas = responses.reduce((a, r) => (r && Array.isArray(r.metas) ? a.concat(r.metas) : a), []);
  res.json({ metas });
});

// Meta V4
app.post('/meta', async (req, res) => {
  const responses = await broadcastPost('meta', req.body);
  console.log('Meta raw responses:', responses);
  const metas = [];
  responses.forEach(r => {
    if (!r) return;
    if (r.meta) metas.push(r.meta);
    if (Array.isArray(r.metas)) metas.push(...r.metas);
  });
  res.json({ metas });
});

// Stream V4
app.post('/stream', async (req, res) => {
  const responses = await broadcastPost('stream', req.body);
  console.log('Stream raw responses:', responses);
  const streams = responses.reduce((a, r) => (r && Array.isArray(r.streams) ? a.concat(r.streams) : a), []);
  res.json({ streams });
});

// Subtitles V4
app.post('/subtitles', async (req, res) => {
  const responses = await broadcastPost('subtitles', req.body);
  console.log('Subtitles raw responses:', responses);
  const subtitles = responses.reduce((a, r) => (r && Array.isArray(r.subtitles) ? a.concat(r.subtitles) : a), []);
  res.json({ subtitles });
});

// GET V3 /catalog/:type/:id.json
app.get('/catalog/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  const responses = await broadcastGet(`catalog/${type}/${id}.json`);
  console.log('Catalog GET raw responses:', responses);
  const metas = responses.reduce((a, r) => (r && Array.isArray(r.metas) ? a.concat(r.metas) : a), []);
  res.json({ metas });
});

// GET V3 /catalog/:type/:id/:extra.json
app.get('/catalog/:type/:id/:extra.json', async (req, res) => {
  const { type, id, extra } = req.params;
  const responses = await broadcastGet(`catalog/${type}/${id}/${extra}.json`);
  console.log('Catalog Extra GET raw responses:', responses);
  const metas = responses.reduce((a, r) => (r && Array.isArray(r.metas) ? a.concat(r.metas) : a), []);
  res.json({ metas });
});

// Redirect root to manifest
app.get('/', (req, res) => res.redirect('/manifest.json'));

// Start server
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
