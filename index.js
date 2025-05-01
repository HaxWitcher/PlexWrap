// index.js
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

// radimo iz direktorija u kojem je index.js
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

// direktorij sa vašim configA.json, configB.json, …
const CONFIG_DIR = path.join(__dirname, 'configs');
const configs            = {}; // configName -> { bases, baseManifests }
const wrapperManifests   = {}; // configName -> wrapper manifest

// dohvatite sve config imena (bez .json)
const configNames = fs.readdirSync(CONFIG_DIR)
  .filter(f => f.endsWith('.json'))
  .map(f => f.replace(/\.json$/,''))

// inicijaliziraj svaki config
async function initConfig(name) {
  const cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, `${name}.json`)));
  const bases = (cfg.TARGET_ADDON_BASES||[])
    .map(u => u.trim().replace(/\/manifest\.json$/i,'').replace(/\/+$/,''))
    .filter(Boolean);
  
  // fetch svih baza
  const results = await Promise.allSettled(
    bases.map(b => axios.get(`${b}/manifest.json`))
  );
  const baseManifests = [];
  results.forEach((r,i) => {
    if (r.status==='fulfilled' && Array.isArray(r.value.data.catalogs)) {
      baseManifests.push({ base: bases[i], manifest: r.value.data });
    }
  });
  configs[name] = { bases, baseManifests };

  // složi wrapper manifest s manifestVersion:'4'
  const all = baseManifests.map(bm=>bm.manifest);
  wrapperManifests[name] = {
    manifestVersion: '4',
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
  .then(()=> console.log(`🎉 Svi configi spremni: ${configNames.join(', ')}`))
  .catch(e=> {
    console.error('Greška pri init-u:', e);
    process.exit(1);
  });

// serviraj manifest.json za svaki config
app.get('/:config/manifest.json', (req,res)=>{
  const m = wrapperManifests[req.params.config];
  if(!m) return res.status(404).json({ error:'Config not found' });
  res.json(m);
});

// factory za POST proxy
function makePost(key) {
  return async (req,res) => {
    const conf = req.params.config;
    const cfg  = configs[conf];
    if(!cfg) return res.json({ [key]: [] });

    let targets = cfg.baseManifests;
    if(key==='metas') {
      const id = req.body.id;
      targets = targets.filter(bm =>
        bm.manifest.catalogs.some(c=>c.id===id)
      );
    }
    const arr = await Promise.all(
      targets.map(bm =>
        axios.post(
          `${bm.base}/${ key==='metas' ? 'catalog' : key }`,
          req.body,
          { headers:{ 'Content-Type':'application/json' } }
        )
        .then(r=>r.data)
        .catch(()=>null)
      )
    );
    const combined = arr.reduce((acc,r)=>{
      if(r && Array.isArray(r[key])) acc.push(...r[key]);
      return acc;
    }, []);
    res.json({ [key]: combined });
  };
}

// POST endpointi per config
app.post('/:config/catalog',    makePost('metas'));
app.post('/:config/meta',       makePost('metas'));
app.post('/:config/stream',     makePost('streams'));
app.post('/:config/subtitles',  makePost('subtitles'));

// start
const PORT = process.env.PORT||7000;
app.listen(PORT, ()=>console.log(`🔌 Listening on :${PORT}`));
