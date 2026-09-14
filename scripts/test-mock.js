#!/usr/bin/env node
// Dev-only validation: runs the API against a minimal in-process mock of the
// Supabase PostgREST layer to verify route wiring end-to-end without real
// credentials. Usage: node scripts/test-mock.js

// skip the .env load in database.js so the mock credentials below are used,
// and the test never touches the real Supabase project
process.env.DB_SKIP_DOTENV = '1';
process.env.SUPABASE_URL = 'http://127.0.0.1:8899';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-key-for-tests';
process.env.PORT = '4555';
process.env.REPOVAULT_SKIP_REPO_SYNC = '1'; // never clone real repos during tests



const express = require('express');
const http = require('http');

/* ---------------- minimal PostgREST mock ---------------- */
const store = { projects: [], tags: [], project_tags: [], recipes: [] };
let nextId = { projects: 1, tags: 1, recipes: 1, runs: 1 };

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function tableOf(pathname) {
  return pathname.replace(/^\/rest\/v1\//, '').replace(/^rpc\//, '');
}

function wantsSingle(req) {
  return String(req.headers.accept || '').includes('vnd.pgrst.object+json');
}

function representation(req, rows) {
  if (!String(req.headers.prefer || '').includes('return=representation')) return [];
  return wantsSingle(req) && rows.length ? rows[0] : rows;
}

app.all('/rest/v1/rpc/:fn', (req, res) => res.status(204).end());

app.route('/rest/v1/:table').all((req, res, next) => {
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const table = tableOf(req.originalUrl.split('?')[0]);
  console.log('[mock]', req.method, req.originalUrl);
  const rows = store[table] || (store[table] = []);

  if (req.method === 'POST') {
    const incoming = Array.isArray(req.body) ? req.body : [req.body];
    const onConflict = new URL(req.originalUrl, 'http://x').searchParams.get('on_conflict'); // e.g. "name"
    const conflictCols = onConflict ? onConflict.split(',') : null;
    const created = incoming.map((b) => {
      let row = null;
      if (conflictCols) {
        // upsert semantics: replace matching row, else insert
        const existing = rows.find((r) => conflictCols.every((c) => String(r[c]) === String(b[c])));
        if (existing) {
          Object.assign(existing, b, { id: existing.id });
          row = { ...existing };
          return row;
        }
      }
      row = { ...b };
      if (row.id === undefined) row.id = nextId[table]++;
      if (!row.created_at) row.created_at = new Date().toISOString();
      if (!row.started_at) row.started_at = new Date().toISOString();
      rows.push(row);
      return row;
    });
    const out = representation(req, created.filter(Boolean));
    return res.status(201).json(out); // [] | single object | array
  }

  // crude filters: any column=eq.N | column=in.(a,b) | column=ilike.%x%
  const params = new URL(req.originalUrl, 'http://x').searchParams;
  const filters = [];
  for (const [key, value] of params) {
    if (key === 'select' || key === 'order' || key === 'limit' || key === 'or' || key === 'on_conflict' || key === 'columns') continue;
    if (value.startsWith('eq.')) filters.push([key, (r) => Number(r[key]) === Number(value.slice(3))]);
    else if (value.startsWith('in.(')) {
      const items = value.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, ''));
      filters.push([key, (r) => items.includes(String(r[key]))]);
    } else if (value.startsWith('ilike.')) {
      const pat = value.slice(6).replace(/\*/g, '');
      filters.push([key, (r) => String(r[key]).toLowerCase().includes(pat.toLowerCase())]);
    }
  }
  const match = (r) => filters.every(([, fn]) => fn(r));

  if (req.method === 'PATCH') {
    const updated = [];
    for (const r of rows) if (match(r)) { Object.assign(r, req.body); updated.push({ ...r }); }
    return res.json(representation(req, updated));
  }
  if (req.method === 'DELETE') {
    const removed = rows.filter(match);
    store[table] = rows.filter((r) => !match(r));
    return res.json(representation(req, removed));
  }
  // GET — return rows, adding any requested embeds
  const select = new URL(req.originalUrl, 'http://x').searchParams.get('select') || '';
  const out = rows.filter(match).map((r) => {
    const copy = { ...r };
    if (select.includes('recipes(title')) {
      const rec = store.recipes.find((x) => x.id === r.recipe_id);
      copy.recipes = rec ? { title: rec.title, command: rec.command } : null;
    }
    if (select.includes('project_tags(count)')) {
      copy.project_tags = [{ count: store.project_tags.filter((l) => l.tag_id === r.id).length }];
    }
    if (select.includes('tags(name)')) {
      const t = store.tags.find((x) => x.id === r.tag_id);
      copy.tags = t ? { name: t.name } : null;
    }
    return copy;
  });
  return res.json(out);
});

const mockServer = http.createServer(app).listen(8899, () => {
  console.log('mock PostgREST on :8899');
  runTests();
});

module.exports = { store, mockServer };


/* ---------------- exercise the real API ---------------- */
const { getRun } = require('../src/services/runner');
const routes = {
  projects: require('../src/routes/projects'),
  recipes: require('../src/routes/recipes'),
  runs: require('../src/routes/runs'),
  tags: require('../src/routes/tags'),
};
const api = express();
api.use(express.json());
for (const [k, v] of Object.entries(routes)) api.use(`/api/${k}`, v);
api.use((err, req, res, next) => res.status(500).json({ error: err.message }));

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

async function call(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${process.env.PORT}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

async function runTests() {
  await new Promise((r) => api.listen(process.env.PORT, r));

  console.log('\n-- projects --');
  let r = await call('POST', '/projects', { name: 'PDF Tools', repo_url: 'https://github.com/x/pdf', tags: ['pdf', 'cli'] });
  check('POST /projects -> 201', r.status === 201 && r.json.name === 'PDF Tools' && r.json.id === 1, JSON.stringify(r.json));
  const pid = r.json.id;

  r = await call('GET', '/projects');
  check('GET /projects -> list with tags', r.status === 200 && r.json[0].tags.includes('pdf'), JSON.stringify(r.json));

  r = await call('GET', '/projects?q=pdf');
  check('GET /projects?q= -> 200', r.status === 200 && r.json.length === 1);

  r = await call('GET', `/projects/${pid}`);
  check('GET /projects/:id -> detail', r.status === 200 && r.json.tags.includes('cli'));

  r = await call('PUT', `/projects/${pid}`, { purpose: 'convert pdfs', tags: ['pdf'] });
  check('PUT /projects/:id -> updated', r.status === 200 && r.json.purpose === 'convert pdfs' && r.json.tags.length === 1, JSON.stringify(r.json));

  console.log('\n-- recipes --');
  r = await call('POST', '/recipes', { project_id: pid, title: 'Run', command: 'echo hello' });
  check('POST /recipes -> 201', r.status === 201 && r.json.id === 1, JSON.stringify(r.json));
  const rid = r.json.id;

  r = await call('GET', `/recipes?project_id=${pid}`);
  check('GET /recipes?project_id -> 200', r.status === 200 && r.json.length === 1);

  r = await call('PUT', `/recipes/${rid}`, { title: 'Run v2' });
  check('PUT /recipes/:id -> 200', r.status === 200 && r.json.title === 'Run v2');

  console.log('\n-- runs --');
  r = await call('POST', `/recipes/${rid}/run`, { input: '' });
  check('POST /recipes/:id/run -> 202', r.status === 202 && r.json.run_id === 1, JSON.stringify(r.json));
  const runId = r.json.run_id;
  await new Promise((res) => setTimeout(res, 700)); // let bash finish + persist

  r = await call('GET', `/runs/${runId}`);
  check('GET /runs/:id -> flattened recipe_title', r.status === 200 && r.json.recipe_title === 'Run v2' && /hello/.test(r.json.output || ''), JSON.stringify(r.json));
  check('run record finished in memory', ['success', 'failed'].includes(getRun(runId).status));

  r = await call('GET', `/runs?recipe_id=${rid}&limit=50`);
  check('GET /runs?recipe_id -> history', r.status === 200 && r.json.length === 1);

  r = await call('POST', `/recipes/${rid}/kill`);
  check('POST /recipes/:id/kill -> 404 when not running', r.status === 404 || r.status === 200);

  console.log('\n-- tags --');
  r = await call('GET', '/tags');
  check('GET /tags -> counts', r.status === 200 && r.json[0].project_count === 1, JSON.stringify(r.json));

  console.log('\n-- delete --');
  r = await call('DELETE', `/projects/${pid}`);
  check('DELETE /projects/:id -> ok', r.status === 200 && r.json.ok === true);

  console.log(`\n${passed} passed, ${failed} failed`);
  mockServer.close();
  process.exit(failed ? 1 : 0);
}
