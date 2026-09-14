#!/usr/bin/env node
// Applies supabase/schema.sql to the Supabase Postgres database over a direct
// connection (the REST API key cannot run DDL).
//
// Usage:
//   node scripts/apply-schema.js "<session-pooler-connection-string>"
// or put the connection string in .env as SUPABASE_DB_URL and run:
//   node scripts/apply-schema.js
//
// The connection string is in Supabase Dashboard -> Connect -> Session pooler,
// e.g. postgresql://postgres.<project-ref>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:5432/postgres

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const conn =
  process.argv[2] ||
  process.env.SUPABASE_DB_URL ||
  (process.env.SUPABASE_DB_PASSWORD && process.env.SUPABASE_DB_HOST
    ? `postgresql://postgres.${process.env.SUPABASE_DB_PROJECT_REF || 'YOUR-PROJECT-REF'}:${encodeURIComponent(
        process.env.SUPABASE_DB_PASSWORD
      )}@${process.env.SUPABASE_DB_HOST}:5432/postgres`
    : null);

if (!conn) {
  console.error(
    'No database connection string provided.\n' +
      'Pass it as an argument: node scripts/apply-schema.js "<connection-string>"\n' +
      '(Supabase Dashboard -> Connect -> Session pooler, replace [YOUR-PASSWORD])'
  );
  process.exit(1);
}

const sqlPath = path.join(__dirname, '..', 'supabase', 'schema.sql');
const raw = fs.readFileSync(sqlPath, 'utf8');
// strip comment lines, then split on statement-terminating semicolons
// (safe here: the schema contains no function bodies)
const cleaned = raw
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');
const statements = cleaned
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

(async () => {
  const client = new Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('✓ connected to database');
  try {
    for (const stmt of statements) {
      await client.query(stmt);
      console.log(`  ✓ ${stmt.split('\n')[0].slice(0, 70)}`);
    }
    const { rows } = await client.query(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name in ('projects','tags','project_tags','recipes')
       order by table_name`
    );
    console.log('✓ tables present:', rows.map((r) => r.table_name).join(', '));
    console.log('\nDone. PostgREST picks up the new schema automatically (may take a few seconds).');
  } finally {
    await client.end();
  }
})().catch((err) => {
  console.error('✗ failed:', err.message);
  process.exit(1);
});
