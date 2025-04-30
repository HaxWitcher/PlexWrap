const express = require('express');
const axios = require('axios');
const fs = require('fs');
const app = express();
app.use(express.json());

// Učitavamo sve ciljne baze iz config.json ili iz Heroku ENV varijable
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

// Funkcija za izgradnju wrapper manifest-a, ignorira neispravne baze
async function buildWrapperManifest() {
  const results = await Promise.allSettled(
    bases.map(b => axios.get(`${b.replace(/\/$/, '')}/manifest.json`))
  );
  const manifests = results
    .map((res, idx) => {
      if (res.status === 'fulfilled') return res.value.data;
      console.warn(`Manifest fetch failed for ${bases[idx]}: ${res.reason.message}`);
      return null;
    })
    .filter(m => m);

  if (manifests.length === 0) {
    console.error('Nijedan validan manifest nije dohvaćen. Prekidam izvođenje.');
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
  .then(manifest => {
    wrapperManifest = manifest;
    console.log(`Wrapper manifest je spreman (uspješno dohvaćeno ${wrapperManifest.catalogs.length} stavki).`);
  })
  .catch(err => {
    console.error('Greška pri izgradnji wrapper manifest-a:', err.message);
    process.exit(1);
  });

// Serviranje wrapper manifest-a
app.get('/manifest.json', (req, res) => {
  if (!wrapperManifest) {
    return res.status(503).json({ error: 'Manifest još nije spreman, probajte kasnije.' });
  }
  res.json(wrapperManifest);
});

// Fan-out POST proxy
async function broadcastPost(path, body) {
  const calls = bases.map(b => {
    const url = `${b.replace(/\/$/, '')}/${path}`;
    return axios.post(url, body, { headers: { 'Content-Type': 'application/json' } })
      .then(r => r.data)
      .catch(err => {
        console.warn(`Proxy POST failed for ${url}: ${err.message}`);
        return null;
      });
  });
  return Promise.all(calls);
}

// Endpoints
app.post('/catalog/:type', async (req, res) => {
  const responses = await broadcastPost(`catalog/${req.params.type}`, req.body);
  const metas = responses.reduce((acc, r) => {
    if (r && Array.isArray(r.metas)) acc.push(...r.metas);
    return acc;
  }, []);
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
  const streams = responses.reduce((acc, r) => {
    if (r && Array.isArray(r.streams)) acc.push(...r.streams);
    return acc;
  }, []);
  res.json({ streams });
});

app.post('/subtitles', async (req, res) => {
  const responses = await broadcastPost('subtitles', req.body);
  const subtitles = responses.reduce((acc, r) => {
    if (r && Array.isArray(r.subtitles)) acc.push(...r.subtitles);
    return acc;
  }, []);
  res.json({ subtitles });
});

// Opcionalno: redirekt za root
app.get('/', (req, res) => res.redirect('/manifest.json'));

// Start server
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Proxy addon sluša na portu ${PORT}`));
