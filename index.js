const express = require('express');
const axios = require('axios');
const fs = require('fs');
const app = express();

// Omogućavamo CORS za Stremio klijenta
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
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
if (process.env.TARGET_ADDON_BASES) {
  bases = process.env.TARGET_ADDON_BASES.split(',');
}
if (!Array.isArray(bases) || bases.length === 0) {
  console.error('TARGET_ADDON_BASES nije definisan ili je prazan niz!');
  process.exit(1);
}

// Dohvat i izgradnja wrapper manifest-a (ignore neuspjele)
async function buildWrapperManifest() {
  const results = await Promise.allSettled(
    bases.map(b => axios.get(`${b.replace(/\/$/, '')}/manifest.json`))
  );
  const manifests = results
    .map((res, idx) => res.status === 'fulfilled' ? res.value.data : null)
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
    resources: ['catalog','meta','stream','subtitles'],
    types: [...new Set(manifests.flatMap(m => m.types || []))],
    idPrefixes: [...new Set(manifests.flatMap(m => m.idPrefixes || []))],
    catalogs: manifests.flatMap(m => m.catalogs || []),
    logo: manifests[0].logo || '',
    icon: manifests[0].icon || ''
  };
}

let wrapperManifest;
buildWrapperManifest().then(manifest => {
  wrapperManifest = manifest;
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

// Fan-out helper za POST
async function broadcastPost(path, body) {
  return Promise.all(
    bases.map(b => axios.post(`${b.replace(/\/$/, '')}/${path}`, body, { headers: { 'Content-Type': 'application/json' } })
      .then(r => r.data)
      .catch(err => {
        console.warn(`Proxy POST failed for ${b}/${path}: ${err.message}`);
        return null;
      })
    )
  );
}

// Katalog endpoint za V4 spec: POST /catalog
app.post('/catalog', async (req, res) => {
  const responses = await broadcastPost('catalog', req.body);
  const metas = responses.reduce((acc, r) => {
    if (r && Array.isArray(r.metas)) acc.push(...r.metas);
    return acc;
  }, []);
  res.json({ metas });
});

// Meta endpoint: POST /meta
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

// Stream endpoint: POST /stream
app.post('/stream', async (req, res) => {
  const responses = await broadcastPost('stream', req.body);
  const streams = responses.reduce((acc, r) => {
    if (r && Array.isArray(r.streams)) acc.push(...r.streams);
    return acc;
  }, []);
  res.json({ streams });
});

// Subtitles endpoint: POST /subtitles
app.post('/subtitles', async (req, res) => {
  const responses = await broadcastPost('subtitles', req.body);
  const subs = responses.reduce((acc, r) => {
    if (r && Array.isArray(r.subtitles)) acc.push(...r.subtitles);
    return acc;
  }, []);
  res.json({ subtitles: subs });
});

// Redirect root
app.get('/', (req, res) => res.redirect('/manifest.json'));

// Pokretanje servera
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Proxy addon sluša na portu ${PORT}`));
