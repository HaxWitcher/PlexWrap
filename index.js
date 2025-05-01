// index.js
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

// Run from addon folder
process.chdir(path.dirname(__filename));
const app = express();

// CORS for Stremio
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// Config directory
const CONFIG_DIR = path.join(__dirname, 'configs');
const configs = {};
const wrapperManifests = {};

// Discover config names
const configNames = fs.readdirSync(CONFIG_DIR)
  .filter(f => f.endsWith('.json'))
  .map(f => f.replace(/\.json$/, ''));

// Initialize one config: load bases, fetch manifests, build wrapper
async function initConfig(name) {
  const cfgData = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, `${name}.json`)));
  const basesRaw = cfgData.TARGET_ADDON_BASES || [];
  const bases = basesRaw
    .map(u => u.trim().replace(/\/+$/, '').replace(/\/manifest\\.json$/i, ''))
    .filter(Boolean);

  const items = [];
  const results = await Promise.allSettled(
    bases.map(b => axios.get(`${b}/manifest.json`))
  );
  results.forEach((r,i) => {
    if (r.status==='fulfilled' && r.value.data.catalogs) {
      items.push({ base: bases[i], manifest: r.value.data });
    }
  });
  configs[name] = { bases, items };

  // wrapper manifest
  const manArr = items.map(it => it.manifest);
  wrapperManifests[name] = {
    id: `stremio-proxy-${name}`,
    version: '1.0.0',
    name: `Stremio Proxy (${name})`,
    description: 'Proxy svih vaših Stremio addon-a',
    resources: ['catalog','meta','stream','subtitles'],
    types: [...new Set(manArr.flatMap(m=>m.types||[]))],
    idPrefixes: [...new Set(manArr.flatMap(m=>m.idPrefixes||[]))],
    catalogs: manArr.flatMap(m=>m.catalogs||[]),
    logo: manArr[0]?.logo||'', icon: manArr[0]?.icon||''
  };
  console.log(`✅ [${name}] inicijalizirano: ${bases.length} baza, ${wrapperManifests[name].catalogs.length} kataloga`);
}

// Init all
(async()=>{
  await Promise.all(configNames.map(initConfig));
  console.log(`🎉 Svi configi spremni: ${configNames.join(', ')}`);
})();

// Serve manifest
app.get('/:cfg/manifest.json', (req,res) => {
  const m = wrapperManifests[req.params.cfg];
  return m
    ? res.json(m)
    : res.status(404).json({error:'Config not found'});
});

// POST handlers
function makeHandler(key, pathSegment) {
  return async (req,res) => {
    const cfg = configs[req.params.cfg];
    if (!cfg) return res.json({ [key]: [] });
    let targets = cfg.items;
    if (key==='metas') { // catalog
      const id = req.body.id;
      targets = targets.filter(it => it.manifest.catalogs.some(c=>c.id===id));
    }
    const calls = targets.map(it =>
      axios.post(`${it.base}/${pathSegment}`, req.body, {headers:{'Content-Type':'application/json'}})
        .then(r=>r.data).catch(()=>null)
    );
    const resArr = await Promise.all(calls);
    const combined = resArr.reduce((acc,r)=>{
      if (!r) return acc;
      const arr = r[key] || [];
      return acc.concat(arr);
    }, []);
    res.json({ [key]: combined });
  }
}
app.post('/:cfg/catalog',   makeHandler('metas','catalog'));
app.post('/:cfg/meta',      makeHandler('metas','meta'));
app.post('/:cfg/stream',    makeHandler('streams','stream'));
app.post('/:cfg/subtitles', makeHandler('subtitles','subtitles'));

// GET fallback → convert GET /:cfg/catalog/... to POST catalog
app.get('/:cfg/:path(*)', async (req,res) => {
  const {cfg, path: pth} = req.params;
  if (pth.startsWith('catalog/')) {
    // emulate POST catalog
    const parts = pth.split('/');
    const body = { id: parts[2]?.replace('.json',''), extra: {} };
    return makeHandler('metas','catalog')(Object.assign(req, { body }), res);
  }
  if (pth.startsWith('stream/'))    return makeHandler('streams','stream')(req,res);
  if (pth.startsWith('subtitles/')) return makeHandler('subtitles','subtitles')(req,res);
  return res.status(404).json({ error:'Not found' });
});

// Listen
const PORT = process.env.PORT||7000;
app.listen(PORT, ()=> console.log(`🔌 Listening on :${PORT}`));
