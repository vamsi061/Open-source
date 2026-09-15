// DB selection:
//  - Supabase when .env provides SUPABASE_URL + a key (SERVICE_ROLE or ANON).
//    Tables live in supabase/schema.sql - run it once in the Supabase SQL Editor.
//  - Otherwise a zero-config local SQLite database (src/db/sqlite-backend.js),
//    created and seeded on first start from src/db/seed.json. The full app works
//    offline; delete data/local.db to reseed from the snapshot.
// Both expose the same surface: db.from(table) builder + q(promise) helper.
if (!process.env.DB_SKIP_DOTENV) require('dotenv').config({ override: true });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const configured = Boolean(supabaseUrl && supabaseKey);
if (supabaseUrl && !supabaseKey) {
  throw new Error(
    'SUPABASE_URL is set but no key. Add SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) ' +
      'to .env, or remove SUPABASE_URL to run in zero-config local mode.'
  );
}

let db, q, backend;

if (configured) {
  const { createClient } = require('@supabase/supabase-js');
  if (/YOUR[-_]/i.test(supabaseUrl) || /YOUR[-_]|<[^>]*>/.test(supabaseKey)) {
    throw new Error(
      'Your .env still contains placeholder values. Fill in the real SUPABASE_URL and ' +
        'SUPABASE_SERVICE_ROLE_KEY from Supabase Dashboard -> Project Settings -> API.'
    );
  }
  db = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  backend = 'supabase';
} else {
  const local = require('./sqlite-backend');
  db = { from: local.from }; // same .from(table) builder surface as supabase-js
  backend = 'sqlite';
  console.log(`[repovault] no .env found — using local SQLite at ${local.DB_PATH}`);
}

// Await a query and throw a readable Error when it fails (works for both backends).
q = async (promise) => {
  const { data, error } = await promise;
  if (error) {
    const err = new Error(error.message);
    err.details = error.details;
    err.hint = error.hint;
    throw err;
  }
  return data;
};

module.exports = db;
module.exports.q = q;
module.exports.backend = backend;
