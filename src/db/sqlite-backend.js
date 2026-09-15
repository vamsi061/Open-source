// Local SQLite backend — a drop-in stand-in for the Supabase client so the app
// boots with ZERO configuration (fresh `git clone` + `npm install` + `npm start`).
//
// Why: the repo is public on GitHub, so real Supabase credentials can never be
// committed. Instead, when no .env is present we serve the same data from a
// local SQLite file, seeded once from src/db/seed.json (a snapshot of the
// catalog). All CRUD works, so the whole UI is functional; if the user later
// adds a .env, Supabase is used instead (delete data/local.db to reseed).
//
// It intentionally implements ONLY the builder surface this app uses
// (see src/routes/*): from().select().eq().ilike().in().or().order().limit()
// .insert().update().delete().upsert().select().single(), plus the two
// relationship embeds the UI needs: projects→categories(name) and
// tags/projects→project_tags(count). Results resolve to { data, error } like
// supabase-js. JSON columns (env) auto-convert to objects, matching Postgres.
//
// Not supported (never used by the app): .range(), .textSearch(), rpc(), auth.

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.REPOVAULT_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'local.db');
const SEED_PATH = path.join(__dirname, 'seed.json');

const TABLES = ['projects', 'categories', 'tags', 'project_tags', 'recipes'];
// columns stored as JSON text (Postgres jsonb in Supabase)
const JSON_COLS = { recipes: ['env'] };

const SCHEMA = `
create table if not exists projects (
  id integer primary key,
  name text not null,
  repo_url text not null default '',
  description text not null default '',
  purpose text not null default '',
  category_id integer references categories(id) on delete set null
);
create table if not exists categories (
  id integer primary key,
  name text not null unique
);
create table if not exists tags (
  id text primary key,
  name text not null
);
create table if not exists project_tags (
  project_id integer not null references projects(id) on delete cascade,
  tag_id text not null references tags(id),
  primary key (project_id, tag_id)
);
create table if not exists recipes (
  id integer primary key,
  project_id integer not null references projects(id) on delete cascade,
  title text not null,
  command text not null,
  args text not null default '',
  setup text not null default '',
  env text not null default '',
  stdin text not null default '',
  working_dir text not null default '',
  use_venv integer not null default 0,
  input_as_args integer not null default 0
);
`;

// data/ is gitignored, so on a fresh clone it does not exist — create it
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(SCHEMA);

// One-time seed from the snapshot (only when the DB is empty).
function seedIfEmpty() {
  const empty = db.prepare('select count(*) as n from projects').get().n === 0;
  if (!empty || !fs.existsSync(SEED_PATH)) return;
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const tx = db.transaction(() => {
    for (const c of seed.categories || [])
      db.prepare('insert or ignore into categories (id, name) values (?, ?)').run(c.id, c.name);
    for (const p of seed.projects || [])
      db.prepare('insert or ignore into projects (id, name, repo_url, description, purpose, category_id) values (?, ?, ?, ?, ?, ?)')
        .run(p.id, p.name, p.repo_url, p.description, p.purpose, p.category_id ?? null);
    for (const t of seed.tags || [])
      db.prepare('insert or ignore into tags (id, name) values (?, ?)').run(t.id, t.name);
    for (const l of seed.project_tags || [])
      db.prepare('insert or ignore into project_tags (project_id, tag_id) values (?, ?)').run(l.project_id, l.tag_id);
    for (const r of seed.recipes || [])
      db.prepare('insert or ignore into recipes (id, project_id, title, command, args, setup, env, stdin, working_dir, use_venv, input_as_args) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(r.id, r.project_id, r.title, r.command, r.args, r.setup, r.env, r.stdin, r.working_dir, r.use_venv ? 1 : 0, r.input_as_args ? 1 : 0);
  });
  tx();
  console.log(`[repovault] local db seeded from src/db/seed.json (${(seed.projects || []).length} projects, ${(seed.recipes || []).length} recipes)`);
}
seedIfEmpty();

// ---------- helpers ----------

function tableRows(table) {
  return db.prepare(`select * from ${table}`).all();
}
function stripEmbeds(row) {
  const { _embeds, ...rest } = row;
  return rest;
}
// column projection: 'a, b, c(count)' -> ['a','b','c']; '*' or null -> null (full row)
function columnsOf(select) {
  if (!select || select.trim() === '*') return null;
  const cols = select.split(',').map((s) => s.trim().split('(')[0].trim()).filter(Boolean);
  return cols.includes('*') ? null : cols; // '*' means all columns (embeds ride along)
}
function project(row, cols) {
  if (!cols) return row;
  const out = {};
  for (const c of cols) if (c in row) out[c] = row[c];
  return out;
}
// Postgres ilike pattern (% wildcards) -> case-insensitive regex
function likeToMatch(pattern) {
  const esc = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + esc.split('%').join('.*') + '$', 'i');
}
// single-row transform after fetch: JSON text cols -> objects (like Postgres jsonb)
function hydrate(table, row, embeds) {
  const out = { ...row };
  for (const col of JSON_COLS[table] || []) {
    if (typeof out[col] === 'string') {
      try { out[col] = JSON.parse(out[col] || '[]'); } catch (_) { out[col] = []; }
    }
  }
  if (embeds) out._embeds = embeds;
  return out;
}
// embed resolution for the relationships the app uses
function resolveEmbeds(table, rows) {
  const need = new Set();
  for (const r of rows) for (const k of Object.keys(r._embeds || {})) need.add(k);
  const cols = (r, key) => r._embeds[key] === 'cols';
  if (need.has('categories')) {
    // projects.select('*, categories(name)')
    const byId = new Map(tableRows('categories').map((c) => [c.id, c]));
    for (const r of rows) {
      const cat = byId.get(r.category_id);
      r.categories = cat ? (cols(r, 'categories') ? { name: cat.name } : cat) : null;
    }
  }
  if (need.has('tags')) {
    // project_tags.select('project_id, tags(name)')
    const byId = new Map(tableRows('tags').map((t) => [t.id, t]));
    for (const r of rows) {
      const tag = byId.get(r.tag_id);
      r.tags = tag ? (cols(r, 'tags') ? { name: tag.name } : tag) : null;
    }
  }
  if (need.has('project_tags')) {
    // tags.select('id, name, project_tags(count)')
    const links = tableRows('project_tags');
    for (const r of rows) {
      const mine = links.filter((l) => l.tag_id === r.id);
      r.project_tags = cols(r, 'project_tags') ? [{ count: mine.length }] : mine;
    }
  }
  if (need.has('projects')) {
    // categories.select('id, name, projects(count)')
    const all = tableRows('projects');
    for (const r of rows) {
      const mine = all.filter((p) => p.category_id === r.id);
      r.projects = cols(r, 'projects') ? [{ count: mine.length }] : mine;
    }
  }
  for (const r of rows) delete r._embeds;
  return rows;
}

// ---------- filter matching ----------

function cmp(op, field, value) {
  const gv = (r) => {
    const v = r[field];
    return typeof v === 'object' && v !== null ? JSON.stringify(v) : v;
  };
  if (op === 'eq') return (r) => String(gv(r)) === String(value);
  if (op === 'neq') return (r) => String(gv(r)) !== String(value);
  if (op === 'gt') return (r) => gv(r) > value;
  if (op === 'gte') return (r) => gv(r) >= value;
  if (op === 'lt') return (r) => gv(r) < value;
  if (op === 'lte') return (r) => gv(r) <= value;
  if (op === 'like') return (r) => likeToMatch(String(value).replace(/\*/g, '%')).test(String(gv(r) ?? ''));
  if (op === 'ilike') return (r) => likeToMatch(value).test(String(gv(r) ?? ''));
  if (op === 'is') return (r) => (value === null ? gv(r) === null || gv(r) === undefined : String(gv(r)) === String(value));
  if (op === 'in') {
    const arr = (Array.isArray(value) ? value : String(value).split(',')).map(String);
    return (r) => arr.includes(String(gv(r)));
  }
  return () => true;
}

// PostgREST or= syntax: "name.ilike.*x*,id.in.(1,2),category_id.eq.null"
function parseOrFilter(expr) {
  const tests = [];
  for (const partRaw of String(expr).split(',')) {
    const part = partRaw.trim();
    if (!part) continue;
    const m = part.match(/^(.+?)\.(eq|neq|gt|gte|lt|lte|like|ilike|is|in)\.(.*)$/);
    if (!m) continue;
    let v = m[3];
    if (v === 'null') v = null;
    else if (/^\((.*)\)$/.test(v)) v = v.slice(1, -1).split(',');
    tests.push({ field: m[1], op: m[2], value: v });
  }
  return (r) => tests.some((t) => cmp(t.op, t.field, t.value)(r));
}

// ---------- query builder ----------

class Builder {
  constructor(table, state) {
    this._table = table;
    this._state = state; // { select, filters, order, limit, embeds, mode, values, onConflict, ignoreDuplicates, single }
    this._count = null;
  }
  select(select, opts = {}) {
    this._state.select = select || '*';
    if (opts.count === 'exact') this._count = 'exact';
    return this;
  }
  _add(field, op, value) {
    this._state.filters.push({ test: cmp(op, field, value), field, op, value });
    return this;
  }
  eq(f, v) { return this._add(f, 'eq', v); }
  neq(f, v) { return this._add(f, 'neq', v); }
  gt(f, v) { return this._add(f, 'gt', v); }
  gte(f, v) { return this._add(f, 'gte', v); }
  lt(f, v) { return this._add(f, 'lt', v); }
  lte(f, v) { return this._add(f, 'lte', v); }
  like(f, v) { return this._add(f, 'like', v); }
  ilike(f, v) { return this._add(f, 'ilike', v); }
  is(f, v) { return this._add(f, 'is', v); }
  in(f, v) { return this._add(f, 'in', v); }
  or(expr) { this._state.filters.push({ test: parseOrFilter(expr) }); return this; }
  order(field, opts = {}) { this._state.order = { field, asc: !opts.ascending }; return this; }
  limit(n) { this._state.limit = n; return this; }
  // writes
  insert(values) { this._state.mode = 'insert'; this._state.values = values; return this; }
  update(values) { this._state.mode = 'update'; this._state.values = values; return this; }
  upsert(values, opts = {}) {
    this._state.mode = 'upsert';
    this._state.values = values;
    this._state.onConflict = opts.onConflict || null;
    this._state.ignoreDuplicates = !!opts.ignoreDuplicates;
    return this;
  }
  delete() { this._state.mode = 'delete'; return this; }
  single() { this._state.single = true; return this; }
  then(resolve, reject) {
    exec(this._table, this._state, this._count).then(resolve, reject);
  }
}

// tables whose rows carry an auto-increment integer id (tags PK is a text uuid)
const HAS_ID = { projects: 1, categories: 1, recipes: 1 };

function nextId(table) {
  return tableRows(table).reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
}

// ---------- executor ----------

// serialize JSON cols and apply defaults before a write
function prepRow(table, row) {
  const r = { ...row };
  for (const col of JSON_COLS[table] || []) {
    if (r[col] !== undefined && typeof r[col] !== 'string') r[col] = JSON.stringify(r[col] ?? []);
  }
  return r;
}

function writeRow(table, row) {
  const cols = Object.keys(row);
  db.prepare(`insert or replace into ${table} (${cols.join(',')}) values (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => row[c]));
}

async function exec(table, st, countMode) {
  try {
    // ---- insert / upsert ----
    if (st.mode === 'insert' || st.mode === 'upsert') {
      const arr = Array.isArray(st.values) ? st.values : [st.values];
      const out = [];
      const tx = db.transaction(() => {
        for (const v of arr) {
          const row = prepRow(table, v);
          if (st.mode === 'upsert') {
            const conflictCols = (st.onConflict || 'id').split(',').map((s) => s.trim());
            const existing = tableRows(table).find((r) => conflictCols.every((c) => String(r[c]) === String(row[c])));
            if (existing && st.ignoreDuplicates) continue;
            if (existing) {
              for (const k of Object.keys(row)) {
                if (row[k] === undefined) continue;
                db.prepare(`update ${table} set ${k} = ? where id = ?`).run(row[k], existing.id);
              }
              out.push({ ...existing, ...row });
              continue;
            }
          }
          if (row.id === undefined) {
            if (HAS_ID[table]) row.id = nextId(table);
            else if (table === 'tags') row.id = require('crypto').randomUUID(); // Postgres uuid default
          }
          writeRow(table, row);
          out.push({ ...row });
        }
      });
      tx();
      const data = out.map((r) => hydrate(table, r, st.embeds));
      resolveEmbeds(table, data);
      const data2 = data.map(stripEmbeds).map((r) => project(r, columnsOf(st.select)));
      return { data: st.single ? data2[0] ?? null : data2, error: null };
    }

    // ---- update / delete ----
    if (st.mode === 'update' || st.mode === 'delete') {
      let rows = tableRows(table);
      for (const f of st.filters) rows = rows.filter(f.test);
      const ids = rows.map((r) => r.id);
      const tx = db.transaction(() => {
        if (st.mode === 'update') {
          const set = prepRow(table, st.values);
          const sets = Object.entries(set).filter(([, v]) => v !== undefined);
          if (sets.length) {
            const sql = `update ${table} set ${sets.map(([k]) => `${k} = ?`).join(', ')} where id = ?`;
            const stmt = db.prepare(sql);
            for (const id of ids) stmt.run(...sets.map(([, v]) => v), id);
          }
        } else {
          const del = db.prepare(`delete from ${table} where id = ?`);
          for (const id of ids) del.run(id);
        }
      });
      tx();
      // PostgREST returns the affected rows as they were when the statement ran —
      // snapshot BEFORE the write (for update we merge the new values in).
      let data = rows.map((r) =>
        hydrate(table, st.mode === 'update' ? { ...r, ...prepRow(table, st.values) } : r, st.embeds)
      );
      resolveEmbeds(table, data);
      data = data.map(stripEmbeds).map((r) => project(r, columnsOf(st.select)));
      return { data: st.single ? data[0] ?? null : data, error: null };
    }

    // ---- read ----
    let rows = tableRows(table).map((r) => hydrate(table, r, st.embeds));
    for (const f of st.filters) rows = rows.filter(f.test);
    resolveEmbeds(table, rows);
    if (st.order) {
      const { field, asc } = st.order;
      rows.sort((a, b) => {
        const x = a[field];
        const y = b[field];
        const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
        return asc ? c : -c;
      });
    }
    if (st.limit != null) rows = rows.slice(0, st.limit);
    const data = rows.map(stripEmbeds).map((r) => project(r, columnsOf(st.select)));
    if (countMode === 'exact') return { data, count: data.length, error: null };
    return { data: st.single ? data[0] ?? null : data, error: null };
  } catch (err) {
    return { data: null, count: null, error: { message: err.message, details: null, hint: null } };
  }
}

function from(table) {
  if (!TABLES.includes(table)) throw new Error(`sqlite-backend: unknown table "${table}"`);
  return new Builder(table, { select: '*', filters: [], order: null, limit: null, embeds: null, mode: null, values: null, single: false });
}

// wrap select() so `tags(name)` / `projects(count)` style embeds are detected
const origSelect = Builder.prototype.select;
Builder.prototype.select = function (select, opts = {}) {
  const embeds = {};
  if (select && select !== '*') {
    for (const part of select.split(',')) {
      const m = part.trim().match(/^([a-z_]+)\((.+)\)$/i);
      if (m) embeds[m[1]] = m[2].trim() === '*' ? true : 'cols';
    }
  }
  this._state.embeds = embeds;
  return origSelect.call(this, select, opts);
};

module.exports = { db, from, DATA_DIR, DB_PATH };
