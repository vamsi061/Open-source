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

// resolve a client-supplied category_id: null, an existing category id,
// or false when the id doesn't exist (caller turns that into a 400)
async function resolveCategory(categoryId) {
  if (categoryId === null || categoryId === undefined || categoryId === '') return null;
  const rows = await q(db.from('categories').select('id').eq('id', categoryId).limit(1));
  return rows.length ? rows[0].id : false;
}

// attach category name (PostgREST embed) to project rows
function shapeCategories(rows) {
  return rows.map((r) => {
    const cat = r.categories;
    const { categories: _embedded, ...rest } = r;
    return { ...rest, category: cat && typeof cat === 'object' ? cat.name : null };
  });
}

// GET /api/projects?q=  - search by name/description/purpose/repo/tags/category
router.get(
  '/',
  wrap(async (req, res) => {
    const text = (req.query.q || '').trim();
    let query = db.from('projects').select('*, categories(name)').order('name');
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
        // extend the search to tag names and category names
        const tagIds = await q(db.from('tags').select('id').ilike('name', `%${text}%`));
        if (tagIds.length) {
          const pts = await q(
            db.from('project_tags').select('project_id').in('tag_id', tagIds.map((t) => t.id))
          );
          if (pts.length)
            parts.push(`id.in.(${[...new Set(pts.map((p) => p.project_id))].join(',')})`);
        }
        const catIds = await q(db.from('categories').select('id').ilike('name', `%${text}%`));
        if (catIds.length) parts.push(`category_id.in.(${catIds.map((c) => c.id).join(',')})`);
        query = query.or(parts.join(','));
      }
    }
    res.json(shapeCategories(await withTags(await q(query))));
  })
);

// GET /api/projects/:id
router.get(
  '/:id',
  wrap(async (req, res) => {
    const rows = await q(db.from('projects').select('*, categories(name)').eq('id', req.params.id).limit(1));
    if (!rows.length) return res.status(404).json({ error: 'Project not found' });
    const [project] = shapeCategories(await withTags(rows));
    const recipes = await q(
      db.from('recipes').select('*').eq('project_id', project.id).order('id')
    );
    res.json({ ...project, recipes });
  })
);

// POST /api/projects  { name, repo_url, description, purpose, tags: [], category_id }
router.post(
  '/',
  wrap(async (req, res) => {
    const { name, repo_url = '', description = '', purpose = '', tags = [], category_id = null } =
      req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const category = await resolveCategory(category_id);
    if (category === false) return res.status(400).json({ error: 'category not found' });
    const project = await q(
      db
        .from('projects')
        .insert({ name, repo_url, description, purpose, category_id: category })
        .select()
        .single()
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
    const { name, repo_url, description, purpose, tags, category_id } = req.body || {};
    const category =
      category_id === undefined ? row.category_id : await resolveCategory(category_id);
    if (category === false) return res.status(400).json({ error: 'category not found' });
    const updated = await q(
      db
        .from('projects')
        .update({
          name: name ?? row.name,
          repo_url: repo_url ?? row.repo_url,
          description: description ?? row.description,
          purpose: purpose ?? row.purpose,
          category_id: category,
        })
        .eq('id', req.params.id)
        .select()
        .single()
    );
    if (Array.isArray(tags)) {
      await q(db.from('project_tags').delete().eq('project_id', req.params.id));
      await attachTagsToProject(updated.id, tags);
    }
    // re-fetch so the response carries the category name embed (the update-select can't)
    const [fresh] = await q(
      db.from('projects').select('*, categories(name)').eq('id', req.params.id).limit(1)
    );
    const [result] = shapeCategories(await withTags([fresh]));
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
