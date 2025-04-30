const express = require('express');
const axios = require('axios');
const fs = require('fs');
const app = express();
app.use(express.json());

// 1) Učitamo sve ciljne baze iz config.json ili iz Heroku ENV
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

// 2) Pri startu dohvatimo sve individualne manifest.json i spojimo u wrapper manifest
let wrapperManifest = null;
(async () => {
  try {
    const ms = await Promise.all(bases.map(b =>
      axios.get(`${b.replace(/\/$/, '')}/manifest.json`).then(r => r.data)
    ));
    wrapperManifest = {
      id: 'stremio-proxy-wrapper',
      version: '1.0.0',
      name: 'Stremio Proxy Wrapper',
      description: 'Proxy svih vaših Stremio addon-a',
      resources: ['catalog','meta','stream','subtitles'],
      types: [...new Set(ms.flatMap(m => m.types || []))],
      idPrefixes: [...new Set(ms.flatMap(m => m.idPrefixes || []))],
      catalogs: ms.flatMap(m => m.catalogs || []),
      logo: ms[0].logo || '',        // možete staviti svoj logo
      icon: ms[0].icon || ''
    };
    console.log('Wrapper manifest je spreman, spojili smo', ms.length, 'addon-a');
  } catch (e) {
    console.error('Greška pri dohvaćanju manifest-a:', e.message);
    process.exit(1);
  }
})();

// 3) Serviramo manifest
app.get('/manifest.json', (req, res) => {
  if (!wrapperManifest) {
    return res.status(503).json({ error: 'Manifest još nije spremljen, probajte kasnije.' });
  }
  res.json(wrapperManifest);
});

// 4) Helper za sinkroni “fan-out” POST proxy
async function broadcastPost(path, body) {
  const calls = bases.map(b => {
    const url = `${b.replace(/\/$/, '')}/${path}`;
    return axios.post(url, body, { headers: { 'Content-Type': 'application/json' } })
      .then(r => r.data)
      .catch(() => null);
  });
  return Promise.all(calls);
}

// 5) Endpointi
// 5a) Catalog
app.post('/catalog/:type', async (req, res) => {
  const responses = await broadcastPost(`catalog/${req.params.type}`, req.body);
  // svaki response očekuje { metas: [...] }
  const all = responses.reduce((acc, r) => {
    if (r && Array.isArray(r.metas)) acc.push(...r.metas);
    return acc;
  }, []);
  res.json({ metas: all });
});

// 5b) Meta
app.post('/meta', async (req, res) => {
  const responses = await broadcastPost('meta', req.body);
  // svaki r očekuje { meta: {...} } ili { metas: [...] }
  const all = [];
  responses.forEach(r => {
    if (!r) return;
    if (r.meta) all.push(r.meta);
    if (Array.isArray(r.metas)) all.push(...r.metas);
  });
  res.json({ metas: all });
});

// 5c) Stream
app.post('/stream', async (req, res) => {
  const responses = await broadcastPost('stream', req.body);
  // svaki r očekuje { streams: [...] }
  const all = responses.reduce((acc, r) => {
    if (r && Array.isArray(r.streams)) acc.push(...r.streams);
    return acc;
  }, []);
  res.json({ streams: all });
});

// 5d) Subtitles
app.post('/subtitles', async (req, res) => {
  const responses = await broadcastPost('subtitles', req.body);
  // svaki r očekuje { subtitles: [...] }
  const all = responses.reduce((acc, r) => {
    if (r && Array.isArray(r.subtitles)) acc.push(...r.subtitles);
    return acc;
  }, []);
  res.json({ subtitles: all });
});

// 6) Start server
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Proxy addon sluša na portu ${PORT}`));
