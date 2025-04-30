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

// Build the wrapper manifest by fetching each addon manifest
async function buildWrapperManifest() {
  const results = await Promise.allSettled(bases.map(b => axios.get(`${b}/manifest.json`)));
  const manifests = results
    .map(r => (r.status === 'fulfilled' ? r.value.data : null))
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

// POST proxy helper for V4 requests
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

// GET proxy helper for V3 requests
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

// V4 Catalog
app.post('/catalog', async (req, res) => {
  const responses = await broadcastPost('catalog', req.body);
  console.log('Catalog raw responses:', responses);
  const metas = responses.reduce((a, r) => (r && Array.isArray(r.metas) ? a.concat(r.metas) : a), []);
  res.json({ metas });
});

// V4 Meta
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

// V4 Stream
app.post('/stream', async (req, res) => {
  const responses = await broadcastPost('stream', req.body);
  console.log('Stream raw responses:', responses);
  const streams = responses.reduce((a, r) => (r && Array.isArray(r.streams) ? a.concat(r.streams) : a), []);
  res.json({ streams });
});

// V4 Subtitles with GET fallback
app.post('/subtitles', async (req, res) => {
  // Try POST first
  const postResponses = await broadcastPost('subtitles', req.body);
  console.log('Subtitles raw responses (POST):', postResponses);
  let subtitles = postResponses.reduce((a, r) => (r && Array.isArray(r.subtitles) ? a.concat(r.subtitles) : a), []);
  // Fallback to GET if POST yields none
  if (subtitles.length === 0) {
    const path = `subtitles/${req.body.type}/${req.body.id}.json`;
    const getResponses = await broadcastGet(path);
    console.log('Subtitles raw responses (GET):', getResponses);
    subtitles = getResponses.reduce((a, r) => (r && Array.isArray(r.subtitles) ? a.concat(r.subtitles) : a), []);
  }
  res.json({ subtitles });
});

// V3 GET Catalog
app.get('/catalog/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  const responses = await broadcastGet(`catalog/${type}/${id}.json`);
  console.log('Catalog GET raw responses:', responses);
  const metas = responses.reduce((a, r) => (r && Array.isArray(r.metas) ? a.concat(r.metas) : a), []);
  res.json({ metas });
});

// V3 GET Catalog with extra
app.get('/catalog/:type/:id/:extra.json', async (req, res) => {
  const { type, id, extra } = req.params;
  const responses = await broadcastGet(`catalog/${type}/${id}/${extra}.json`);
  console.log('Catalog Extra GET raw responses:', responses);
  const metas = responses.reduce((a, r) => (r && Array.isArray(r.metas) ? a.concat(r.metas) : a), []);
  res.json({ metas });
});

// V3 GET Stream
app.get('/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  const responses = await broadcastGet(`stream/${type}/${id}.json`);
  console.log('Stream GET raw responses:', responses);
  const streams = responses.reduce((a, r) => (r && Array.isArray(r.streams) ? a.concat(r.streams) : a), []);
  res.json({ streams });
});

// V3 GET Subtitles
app.get('/subtitles/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  const responses = await broadcastGet(`subtitles/${type}/${id}.json`);
  console.log('Subtitles GET raw responses:', responses);
  const subs = responses.reduce((a, r) => (r && Array.isArray(r.subtitles) ? a.concat(r.subtitles) : a), []);
  res.json({ subtitles: subs });
});

// Redirect root
app.get('/', (req, res) => res.redirect('/manifest.json'));

// Start server
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
