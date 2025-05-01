#!/usr/bin/env node
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

// make sure we run from this folder
process.chdir(path.dirname(__filename));

const app = express();

// CORS + JSON body parsing
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin',  '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// --- Load configs ------------------------------------------------------------
const CONFIG_DIR  = path.join(__dirname, 'configs');
const configFiles = fs.existsSync(CONFIG_DIR)
  ? fs.readdirSync(CONFIG_DIR).filter(f => f.endsWith('.json'))
  : [];
const configNames = configFiles.map(f => f.replace(/\.json$/, ''));

// holds raw baseManifests per config
const configs          = {}; // configs[configName] = [ { base, manifest }, … ]
const wrapperManifests = {}; // wrapperManifests[configName] = merged manifest

async function initConfig(name) {
  const file = path.join(CONFIG_DIR, name + '.json');
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file));
  } catch (e) {
    console.error(`❌ Failed to load ${file}:`, e.message);
    return;
  }

  // clean and dedupe
  const bases = Array.from(new Set(
    (cfg.TARGET_ADDON_BASES || [])
      .map(u => u.trim()
                 .replace(/\/manifest\.json$/i,'')
                 .replace(/\/+$/,''))
      .filter(Boolean)
  ));

  // fetch each manifest
  const results = await Promise.allSettled(
    bases.map(b => axios.get(`${b}/manifest.json`))
  );

  const baseManifests = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.data) {
      baseManifests.push({ base: bases[i], manifest: r.value.data });
    } else {
      console.warn(`⚠️  [${name}] manifest fetch failed for ${bases[i]}`);
    }
  });

  configs[name] = baseManifests;
  if (!baseManifests.length) {
    console.error(`❌ [${name}] no valid addon manifests`);
    return;
  }

  // build wrapper manifest
  const manifests = baseManifests.map(bm => bm.manifest);
  const wrapper = {
    manifestVersion: '4',
    id:              `stremio-proxy-wrapper-${name}`,
    version:         '1.0.0',
    name:            `Stremio Proxy Wrapper (${name})`,
    description:     'Proxy svih vaših Stremio addon-a',
    resources:       ['catalog','meta','stream','subtitles'],
    types:           Array.from(new Set(manifests.flatMap(m => m.types  || []))),
    idPrefixes:      Array.from(new Set(manifests.flatMap(m => m.idPrefixes || []))),
    catalogs:        manifests.flatMap(m => m.catalogs || []),
    logo:            manifests[0].logo || '',
    icon:            manifests[0].icon || ''
  };

  wrapperManifests[name] = wrapper;
  console.log(`✅ [${name}] initialized: ${baseManifests.length} bases, ${wrapper.catalogs.length} catalogs`);
}

// init all
Promise.all(configNames.map(initConfig))
  .then(() => console.log(`🎉 All configs ready: ${configNames.join(', ')}`))
  .catch(err => console.error('❌ init error:', err));

// --- Manifest route ---------------------------------------------------------
app.get('/:config/manifest.json', (req, res) => {
  const w = wrapperManifests[req.params.config];
  if (!w) return res.status(404).json({ error: 'Config not found' });
  res.json(w);
});

// --- POST handlers ----------------------------------------------------------
function makeHandler(key, endpoint) {
  return async (req, res) => {
    const name = req.params.config;
    const bases = configs[name] || [];
    if (!bases.length) return res.json({ [key]: [] });

    // for catalogs, filter by ID
    let targets = bases;
    if (key === 'metas') {
      const id = req.body.id;
      targets = bases.filter(bm =>
        (bm.manifest.catalogs || []).some(c => c.id === id)
      );
    }

    const results = await Promise.allSettled(
      targets.map(bm =>
        axios.post(`${bm.base}/${endpoint}`, req.body, {
          headers: { 'Content-Type':'application/json' }
        })
      )
    );

    // combine
    const combined = [];
    results.forEach(r => {
      if (r.status === 'fulfilled' && r.value.data && Array.isArray(r.value.data[key])) {
        combined.push(...r.value.data[key]);
      }
    });
    res.json({ [key]: combined });
  };
}

app.post('/:config/catalog',    makeHandler('metas',     'catalog'));
app.post('/:config/meta',       makeHandler('metas',     'meta'));
app.post('/:config/stream',     makeHandler('streams',   'stream'));
app.post('/:config/subtitles',  makeHandler('subtitles', 'subtitles'));

// --- GET fallback for v3 compatibility -------------------------------------
app.get('/:config/:path(*)', async (req, res) => {
  const name = req.params.config;
  const bases = configs[name] || [];
  if (!bases.length) return res.status(404).json({ error: 'Config not found' });

  const route = req.params.path;
  let key;
  if (route.startsWith('catalog/'))    key = 'metas';
  else if (route.startsWith('stream/')) key = 'streams';
  else if (route.startsWith('subtitles/')) key = 'subtitles';
  else return res.status(404).json({ error: 'Not found' });

  // filter catalog GET by ID
  let targets = bases;
  if (key === 'metas') {
    const parts = route.split('/');
    const id    = parts[2]?.replace('.json','');
    targets = bases.filter(bm =>
      (bm.manifest.catalogs || []).some(c => c.id === id)
    );
  }

  const results = await Promise.allSettled(
    targets.map(bm => axios.get(`${bm.base}/${route}`))
  );
  const combined = [];
  results.forEach(r => {
    if (r.status === 'fulfilled' && r.value.data && Array.isArray(r.value.data[key])) {
      combined.push(...r.value.data[key]);
    }
  });
  res.json({ [key]: combined });
});

// --- Start server -----------------------------------------------------------
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`🔌 Listening on :${PORT}`));
