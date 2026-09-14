// Supabase client (replaces local SQLite).
// Config comes from .env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (see .env.example).
// Tables/functions live in supabase/schema.sql - run it once in the Supabase SQL Editor.
if (!process.env.DB_SKIP_DOTENV) require('dotenv').config({ override: true });
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error(
    'Supabase is not configured. Create a .env file (copy .env.example) with\n' +
      '  SUPABASE_URL=https://<project-ref>.supabase.co\n' +
      '  SUPABASE_SERVICE_ROLE_KEY=<service-role key>\n' +
      'Both are in Supabase Dashboard -> Project Settings -> API. ' +
      'Then run supabase/schema.sql once in the SQL Editor.'
  );
}
if (/YOUR[-_]/i.test(SUPABASE_URL) || /YOUR[-_]|<[^>]*>/.test(SUPABASE_KEY)) {
  throw new Error(
    'Your .env still contains placeholder values. Fill in the real SUPABASE_URL and ' +
      'SUPABASE_SERVICE_ROLE_KEY from Supabase Dashboard -> Project Settings -> API.'
  );
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Await a Supabase query and throw a readable Error when it fails.
async function q(promise) {
  const { data, error } = await promise;
  if (error) {
    const err = new Error(error.message);
    err.details = error.details;
    err.hint = error.hint;
    throw err;
  }
  return data;
}

module.exports = db;
module.exports.q = q;
