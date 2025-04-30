const express = require('express');
const axios = require('axios');
const fs = require('fs');
const app = express();

// Omogućavamo CORS za Stremio klijenta
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// Učitavamo ciljne addon baze iz config.json ili iz Heroku ENV
let bases = [];
try {
  const cfg = JSON.parse(fs.readFileSync('./config.json'));
  bases = cfg.TARGET_ADDON_BASES;
} catch (e) {
  console.error('Ne mogu učitati config.json:', e.message);
  process.exit(1);
}
if (process.env.TARGET_ADDON_BASES) bases = process.env.TARGET_ADDON_BASES.split(',');
if (!Array.isArray(bases) || bases.length === 0) {
  console.error('TARGET_ADDON_BASES nije definisan ili je prazan niz!');
  process.exit(1);
}

// Izgradnja wrapper manifest-a
async function buildWrapperManifest() {
  const results = await Promise.allSettled(
    bases.map(b => axios.get(`${b.replace(/\/$/, '')}/manifest.json`))
  );
  const manifests = results
    .map((r, i) => r.status === 'fulfilled' ? r.value.data : null)
    .filter(m => m);
  if (manifests.length === 0) {
    console.error('Nijedan validan manifest nije dohvaćen. Prekidam.');
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
  console.log(`Wrapper manifest spreman, dohvaćeno ${wrapperManifest.catalogs.length} katalog stavki.`);
}).catch(err => {
  console.error('Greška pri izgradnji manifest-a:', err.message);
  process.exit(1);
});

// Serviranje manifest.json
app.get('/manifest.json', (req, res) => {
  if (!wrapperManifest) return res.status(503).json({ error: 'Manifest još nije spreman.' });
  res.json(wrapperManifest);
});

// Helper za POST zahtev (V4)
async function broadcastPost(path, body) {
  return Promise.all(
    bases.map(b => axios.post(`${b.replace(/\/$/, '')}/${path}`, body, { headers: { 'Content-Type': 'application/json' } })
      .then(r => r.data).catch(err => {
        console.warn(`POST ${path} failed for ${b}: ${err.message}`);
        return null;
      })
    )
  );
}

// Helper za GET zahtev (V3)
async function broadcastGet(path) {
  return Promise.all(
    bases.map(b => axios.get(`${b.replace(/\/$/, '')}/${path}`)
      .then(r => r.data).catch(err => {
        console.warn(`GET ${path} failed for ${b}: ${err.message}`);
        return null;
      })
    )
  );
}

// POST endpoints (V4)
app.post('/catalog', async (req, res) => {
  const responses = await broadcastPost('catalog', req.body);
  const metas = responses.reduce((acc, r) => r && Array.isArray(r.metas) ? acc.concat(r.metas) : acc, []);
  res.json({ metas });
});
app.post('/meta', async (req, res) => {
  const responses = await broadcastPost('meta', req.body);
  const metas = responses.reduce((acc, r) => {
    if (!r) return acc;
    if (r.meta) acc.push(r.meta);
    if (Array.isArray(r.metas)) acc.push(...r.metas);
    return acc;
  }, []);
  res.json({ metas });
});
app.post('/stream', async (req, res) => {
  const responses = await broadcastPost('stream', req.body);
  const streams = responses.reduce((acc, r) => r && Array.isArray(r.streams) ? acc.concat(r.streams) : acc, []);
  res.json({ streams });
});
app.post('/subtitles', async (req, res) => {
  const responses = await broadcastPost('subtitles', req.body);
  const subs = responses.reduce((acc, r) => r && Array.isArray(r.subtitles) ? acc.concat(r.subtitles) : acc, []);
  res.json({ subtitles: subs });
});

// GET endpoints (V3 compatibility)
app.get('/catalog/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  const responses = await broadcastGet(`catalog/${type}/${id}.json`);
  const metas = responses.reduce((acc, r) => r && Array.isArray(r.metas) ? acc.concat(r.metas) : acc, []);
  res.json({ metas });
});
app.get('/catalog/:type/:id/:extra.json', async (req, res) => {
  const { type, id, extra } = req.params;
  const responses = await broadcastGet(`catalog/${type}/${id}/${extra}.json`);
  const metas = responses.reduce((acc, r) => r && Array.isArray(r.metas) ? acc.concat(r.metas) : acc, []);
  res.json({ metas });
});

// Redirect root
app.get('/', (req, res) => res.redirect('/manifest.json'));

// Start server
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Proxy addon sluša na portu ${PORT}`));
