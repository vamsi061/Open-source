#!/usr/bin/env node
// One-time migration: push data from the old local SQLite DB (data/repovault.db)
// into Supabase. IDs are remapped (not preserved), so run this once against a
// fresh schema, then delete data/ to avoid accidentally re-importing.
//
// Usage:  node scripts/migrate-sqlite-to-supabase.js

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env first (see .env.example).');
  process.exit(1);
}

const sqlitePath = path.join(__dirname, '..', 'data', 'repovault.db');
if (!fs.existsSync(sqlitePath)) {
  console.log('No local data/repovault.db found — nothing to migrate.');
  process.exit(0);
}

const sqlite = new DatabaseSync(sqlitePath);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function q(promise, label) {
  const { data, error } = await promise;
  if (error) {
    console.error(`✗ ${label}:`, error.message, error.details || '');
    process.exit(1);
  }
  return data;
}

(async () => {
  const projects = sqlite.prepare('SELECT * FROM projects ORDER BY id').all();
  const tags = sqlite.prepare('SELECT * FROM tags ORDER BY id').all();
  const projectTags = sqlite.prepare('SELECT * FROM project_tags').all();
  const recipes = sqlite.prepare('SELECT * FROM recipes ORDER BY id').all();
  console.log(
    `Read from SQLite: ${projects.length} projects, ${tags.length} tags, ${projectTags.length} links, ${recipes.length} recipes (run history is not migrated — it is no longer stored)`
  );

  // --- projects ---
  const projectIdMap = new Map();
  for (const p of projects) {
    const [row] = await q(
      supabase
        .from('projects')
        .upsert(
          { name: p.name, repo_url: p.repo_url || '', description: p.description || '', purpose: p.purpose || '' },
          { onConflict: 'name' }
        )
        .select('id'),
      `upsert project ${p.name}`
    );
    projectIdMap.set(p.id, row.id);
  }
  console.log(`✓ projects migrated (${projectIdMap.size})`);

  // --- tags --- (shared table without unique-on-name: select, insert missing only)
  const tagIdMap = new Map();
  if (tags.length) {
    const names = [...new Set(tags.map((t) => t.name))];
    const existing = await q(supabase.from('tags').select('id, name').in('name', names), 'select tags');
    const byName = new Map(existing.map((t) => [String(t.name).toLowerCase(), t.id]));
    const missing = names.filter((n) => !byName.has(n.toLowerCase()));
    if (missing.length) {
      const created = await q(
        supabase.from('tags').insert(missing.map((n) => ({ name: n }))).select('id, name'),
        'insert tags'
      );
      for (const t of created) byName.set(String(t.name).toLowerCase(), t.id);
    }
    for (const t of tags) {
      const id = byName.get(String(t.name).toLowerCase());
      if (id) tagIdMap.set(t.id, id);
    }
    console.log(`✓ tags migrated (${tagIdMap.size})`);
  }

  // --- project_tags ---
  if (projectTags.length) {
    const links = [
      ...new Map(
        projectTags.map((pt) => [
          `${projectIdMap.get(pt.project_id)}-${tagIdMap.get(pt.tag_id)}`,
          { project_id: projectIdMap.get(pt.project_id), tag_id: tagIdMap.get(pt.tag_id) },
        ])
      ).values(),
    ];
    await q(
      supabase
        .from('project_tags')
        .upsert(links, { onConflict: 'project_id,tag_id', ignoreDuplicates: true }),
      'upsert project_tags'
    );
    console.log(`✓ project↔tag links migrated (${links.length})`);
  }

  // --- recipes ---
  const recipeIdMap = new Map();
  for (const r of recipes) {
    const [row] = await q(
      supabase
        .from('recipes')
        .insert({
          project_id: projectIdMap.get(r.project_id),
          title: r.title,
          command: r.command,
          args: r.args || '',
          setup: r.setup || '',
          env: r.env || '',
          working_dir: r.working_dir || '',
          use_venv: r.use_venv ? 1 : 0,
        })
        .select('id'),
      `insert recipe ${r.title}`
    );
    recipeIdMap.set(r.id, row.id);
  }
  console.log(`✓ recipes migrated (${recipeIdMap.size})`);

  console.log('\nMigration complete. Your projects, tags and recipes now live in Supabase. 🎉');
  console.log('Note: run history was not migrated (runs are no longer stored).');
  console.log('Tip: delete the local data/repovault.db so you never run this twice by accident.');
})().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
