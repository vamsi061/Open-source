const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { q } = require('../db/database');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function attachTagsToProject(projectId, names) {
  if (!Array.isArray(names) || !names.length) return;
  const wanted = [...new Set(names.map((n) => String(n).trim()).filter(Boolean))];
  if (!wanted.length) return;
  // The tags table is shared with the Resource Vault app and may not have a
  // unique constraint on name, so we never upsert on it: look up existing
  // rows first, insert only the missing ones, then link.
  const existing = await q(db.from('tags').select('id, name').in('name', wanted));
  const byName = new Map(existing.map((t) => [String(t.name).toLowerCase(), t.id]));
  const missing = wanted.filter((n) => !byName.has(n.toLowerCase()));
  if (missing.length) {
    const created = await q(db.from('tags').insert(missing.map((n) => ({ name: n }))).select('id, name'));
    for (const t of created) byName.set(String(t.name).toLowerCase(), t.id);
  }
  const links = wanted
    .map((n) => ({ project_id: projectId, tag_id: byName.get(n.toLowerCase()) }))
    .filter((l) => l.tag_id);
  if (links.length)
    await q(
      db
        .from('project_tags')
        .upsert(links, { onConflict: 'project_id,tag_id', ignoreDuplicates: true })
    );
}


// attach tag name arrays to a list of project rows
async function withTags(rows) {
  if (!rows.length) return rows;
  const links = await q(
    db.from('project_tags').select('project_id, tags(name)').in('project_id', rows.map((r) => r.id))
  );
  const map = new Map();
  for (const l of links) map.set(l.project_id, [...(map.get(l.project_id) || []), l.tags.name]);
  return rows.map((r) => ({ ...r, tags: map.get(r.id) || [] }));
}

// GET /api/projects?q=  - search by name/description/purpose/repo/tags
router.get(
  '/',
  wrap(async (req, res) => {
    const text = (req.query.q || '').trim();
    let query = db.from('projects').select('*').order('name');
    if (text) {
      const safe = text.replace(/[,()*]/g, ' ').trim(); // keep PostgREST or= syntax intact
      if (safe) {
        const like = `*${safe}*`;
        const parts = [
          `name.ilike.${like}`,
          `description.ilike.${like}`,
          `purpose.ilike.${like}`,
          `repo_url.ilike.${like}`,
        ];
        // extend the search to tag names
        const tagIds = await q(db.from('tags').select('id').ilike('name', `%${text}%`));
        if (tagIds.length) {
          const pts = await q(
            db.from('project_tags').select('project_id').in('tag_id', tagIds.map((t) => t.id))
          );
          if (pts.length)
            parts.push(`id.in.(${[...new Set(pts.map((p) => p.project_id))].join(',')})`);
        }
        query = query.or(parts.join(','));
      }
    }
    res.json(await withTags(await q(query)));
  })
);

// GET /api/projects/:id
router.get(
  '/:id',
  wrap(async (req, res) => {
    const rows = await q(db.from('projects').select('*').eq('id', req.params.id).limit(1));
    if (!rows.length) return res.status(404).json({ error: 'Project not found' });
    const [project] = await withTags(rows);
    const recipes = await q(
      db.from('recipes').select('*').eq('project_id', project.id).order('id')
    );
    res.json({ ...project, recipes });
  })
);

// POST /api/projects  { name, repo_url, description, purpose, tags: [] }
router.post(
  '/',
  wrap(async (req, res) => {
    const { name, repo_url = '', description = '', purpose = '', tags = [] } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const project = await q(
      db.from('projects').insert({ name, repo_url, description, purpose }).select().single()
    );
    await attachTagsToProject(project.id, tags);
    res.status(201).json(project);
  })
);

// PUT /api/projects/:id
router.put(
  '/:id',
  wrap(async (req, res) => {
    const rows = await q(db.from('projects').select('*').eq('id', req.params.id).limit(1));
    if (!rows.length) return res.status(404).json({ error: 'Project not found' });
    const row = rows[0];
    const { name, repo_url, description, purpose, tags } = req.body || {};
    const updated = await q(
      db
        .from('projects')
        .update({
          name: name ?? row.name,
          repo_url: repo_url ?? row.repo_url,
          description: description ?? row.description,
          purpose: purpose ?? row.purpose,
        })
        .eq('id', req.params.id)
        .select()
        .single()
    );
    if (Array.isArray(tags)) {
      await q(db.from('project_tags').delete().eq('project_id', req.params.id));
      await attachTagsToProject(updated.id, tags);
    }
    const [result] = await withTags([updated]);
    res.json(result);
  })
);

// DELETE /api/projects/:id  (cascades recipes/runs)
router.delete(
  '/:id',
  wrap(async (req, res) => {
    const deleted = await q(db.from('projects').delete().eq('id', req.params.id).select('id'));
    if (!deleted.length) return res.status(404).json({ error: 'Project not found' });
    res.json({ ok: true });
  })
);

module.exports = router;
