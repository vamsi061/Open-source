#!/usr/bin/env node
// Refreshes src/db/seed.json — the committed snapshot that zero-config (local
// SQLite) mode seeds from. Run this after changing the catalog, then commit.
//
// Reads from the configured backend: Supabase when .env is present, otherwise
// the local SQLite DB (data/local.db).
const fs = require('fs');
const path = require('path');
const db = require('../src/db/database');
const { q } = require('../src/db/database');

(async () => {
  const [cats, proj, tags, pt, rec] = await Promise.all([
    q(db.from('categories').select('*').order('id')),
    q(db.from('projects').select('*').order('id')),
    q(db.from('tags').select('*').order('id')),
    q(db.from('project_tags').select('*')),
    q(db.from('recipes').select('*').order('id')),
  ]);
  // only tags actually linked to a project go into the seed (the tags table is
  // shared with the Resource Vault app — don't snapshot unrelated tags)
  const used = new Set(pt.map((l) => l.tag_id));
  const strip = (rows, drop) => rows.map((r) => { const c = { ...r }; for (const k of drop) delete c[k]; return c; });
  const seed = {
    _comment: 'Snapshot of the RepoVault catalog for zero-config (local SQLite) mode. Regenerate with scripts/dump-seed.js.',
    generated_at: new Date().toISOString(),
    categories: strip(cats, ['created_at']),
    projects: strip(proj, ['created_at']),
    tags: strip(tags.filter((t) => used.has(t.id)), ['created_at']),
    project_tags: pt,
    recipes: strip(rec, ['created_at']),
  };
  const out = path.join(__dirname, '..', 'src', 'db', 'seed.json');
  fs.writeFileSync(out, JSON.stringify(seed, null, 2) + '\n');
  console.log(
    `✓ wrote ${out}\n  categories: ${cats.length} | projects: ${proj.length} | tags: ${seed.tags.length} | links: ${pt.length} | recipes: ${rec.length}`
  );
})().catch((err) => {
  console.error('✗ failed:', err.message);
  process.exit(1);
});
