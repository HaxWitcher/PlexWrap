// index.js
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

// osiguraj da radimo u folderu gdje je index.js
process.chdir(path.dirname(__filename));

const app = express();

// CORS
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin',  '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// Folder u kojem su configA.json, configB.json, …
const CONFIG_DIR = path.join(__dirname, 'configs');
const configs = {};          // configName -> { bases, baseManifests }
const wrapperManifests = {}; // configName -> manifest obj

// učitaj sve .json fajlove iz configs/
const configNames = fs.readdirSync(CONFIG_DIR)
  .filter(f => f.endsWith('.json'))
  .map(f => f.replace(/\.json$/, ''));

async function initConfig(name) {
  const cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, `${name}.json`)));
  let bases = (cfg.TARGET_ADDON_BASES || [])
    .map(u => u.trim().replace(/\/manifest\.json$/i, '').replace(/\/+$/, ''))
    .filter(Boolean);

  // fetch svih manifest.json
  const results = await Promise.allSettled(
    bases.map(b => axios.get(`${b}/manifest.json`))
  );
  const baseManifests = [];
  results.forEach((r,i) => {
    if (r.status === 'fulfilled' && Array.isArray(r.value.data.catalogs)) {
      baseManifests.push({ base: bases[i], manifest: r.value.data });
    }
  });
  configs[name] = { bases, baseManifests };

  // složi wrapper manifest
  const all = baseManifests.map(b => b.manifest);
  wrapperManifests[name] = {
    id:    `stremio-proxy-wrapper-${name}`,
    version: '1.0.0',
    name:  `Stremio Proxy Wrapper (${name})`,
    description: 'Proxy svih vaših Stremio addon-a',
    resources: ['catalog','meta','stream','subtitles'],
    types: [...new Set(all.flatMap(m=>m.types||[]))],
    idPrefixes: [...new Set(all.flatMap(m=>m.idPrefixes||[]))],
    catalogs: all.flatMap(m=>m.catalogs||[]),
    logo:  all[0]?.logo  || '',
    icon:  all[0]?.icon  || ''
  };

  console.log(`✅ [${name}] inicijaliziran: ${bases.length} baza, ${wrapperManifests[name].catalogs.length} katalog stavki`);
}

Promise.all(configNames.map(initConfig))
  .then(() => console.log(`🎉 Svi configi spremni: ${configNames.join(', ')}`))
  .catch(err => {
    console.error('Greška inicijalizacije:', err);
    process.exit(1);
  });

// Serve manifest.json za svaki config
app.get('/:config/manifest.json', (req, res) => {
  const m = wrapperManifests[req.params.config];
  if (!m) return res.status(404).json({ error: 'Config not found' });
  res.json(m);
});

// helper za common POST proxy
function makePost(key) {
  return async (req, res) => {
    const conf = req.params.config;
    const cfg  = configs[conf];
    if (!cfg) return res.json({ [key]: [] });

    let targets = cfg.baseManifests;

    // za katalog filtriraj samo po id koje je Stremio tražio
    if (key === 'metas') {
      const id = req.body.id;
      targets = targets.filter(bm => bm.manifest.catalogs.some(c=>c.id===id));
    }

    const arr = await Promise.all(
      targets.map(bm =>
        axios.post(`${bm.base}/${ key==='metas' ? 'catalog' : key }`,
                   req.body,
                   { headers:{ 'Content-Type':'application/json' } })
             .then(r=>r.data)
             .catch(()=>null)
      )
    );
    const combined = arr.reduce((acc, r) => {
      if (r && Array.isArray(r[key])) acc.push(...r[key]);
      return acc;
    }, []);
    res.json({ [key]: combined });
  };
}

app.post('/:config/catalog',    makePost('metas'));
app.post('/:config/meta',       makePost('metas'));
app.post('/:config/stream',     makePost('streams'));
app.post('/:config/subtitles',  makePost('subtitles'));

// ==== EXPLICIT GET-fallback handlers ====

// GET /:config/catalog/:type/:catalogId.json  → POST /catalog
app.get('/:config/catalog/:type/:catalogId.json', async (req, res) => {
  const { config, type, catalogId } = req.params;
  const cfg = configs[config];
  if (!cfg) return res.status(404).json({ metas: [] });

  const targets = cfg.baseManifests.filter(bm =>
    bm.manifest.catalogs.some(c => c.id === catalogId)
  );
  if (!targets.length) return res.json({ metas: [] });

  const body = { id: catalogId, type, extra: {}, skip: 0 };
  const arr = await Promise.all(
    targets.map(bm =>
      axios.post(`${bm.base}/catalog`, body, { headers:{ 'Content-Type':'application/json' } })
           .then(r=>r.data)
           .catch(()=>null)
    )
  );
  const metas = arr.reduce((acc, r) => {
    if (r && Array.isArray(r.metas)) acc.push(...r.metas);
    return acc;
  }, []);
  res.json({ metas });
});

// GET /:config/stream/:type/:videoId.json → POST /stream
app.get('/:config/stream/:type/:videoId.json', async (req, res) => {
  const { config, type, videoId } = req.params;
  const cfg = configs[config];
  if (!cfg) return res.status(404).json({ streams: [] });

  const body = { id: videoId, type };
  const arr = await Promise.all(
    cfg.baseManifests.map(bm =>
      axios.post(`${bm.base}/stream`, body, { headers:{ 'Content-Type':'application/json' } })
           .then(r=>r.data)
           .catch(()=>null)
    )
  );
  const streams = arr.reduce((acc, r) => {
    if (r && Array.isArray(r.streams)) acc.push(...r.streams);
    return acc;
  }, []);
  res.json({ streams });
});

// GET /:config/subtitles/:type/:videoId.json → POST /subtitles
app.get('/:config/subtitles/:type/:videoId.json', async (req, res) => {
  const { config, type, videoId } = req.params;
  const cfg = configs[config];
  if (!cfg) return res.status(404).json({ subtitles: [] });

  const body = { id: videoId, type };
  const arr = await Promise.all(
    cfg.baseManifests.map(bm =>
      axios.post(`${bm.base}/subtitles`, body, { headers:{ 'Content-Type':'application/json' } })
           .then(r=>r.data)
           .catch(()=>null)
    )
  );
  const subtitles = arr.reduce((acc, r) => {
    if (r && Array.isArray(r.subtitles)) acc.push(...r.subtitles);
    return acc;
  }, []);
  res.json({ subtitles });
});

// start server
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`🔌 Listening on :${PORT}`));
