const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { q } = require('../db/database');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// GET /api/categories - all categories with project counts
router.get(
  '/',
  wrap(async (req, res) => {
    const rows = await q(db.from('categories').select('id, name, projects(count)').order('name'));
    res.json(
      rows.map((c) => ({
        id: c.id,
        name: c.name,
        project_count: c.projects?.[0]?.count ?? 0,
      }))
    );
  })
);

// POST /api/categories  { name }
router.post(
  '/',
  wrap(async (req, res) => {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    // case-insensitive duplicate check (categories has a unique constraint on name)
    const existing = await q(db.from('categories').select('id').ilike('name', name).limit(1));
    if (existing.length) return res.status(409).json({ error: 'category already exists', id: existing[0].id });
    const created = await q(db.from('categories').insert({ name }).select().single());
    res.status(201).json(created);
  })
);

// PUT /api/categories/:id  { name }
router.put(
  '/:id',
  wrap(async (req, res) => {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const rows = await q(db.from('categories').select('*').eq('id', req.params.id).limit(1));
    if (!rows.length) return res.status(404).json({ error: 'Category not found' });
    const updated = await q(db.from('categories').update({ name }).eq('id', req.params.id).select().single());
    res.json(updated);
  })
);

// DELETE /api/categories/:id - projects are kept, just unlinked (FK: on delete set null)
router.delete(
  '/:id',
  wrap(async (req, res) => {
    const deleted = await q(db.from('categories').delete().eq('id', req.params.id).select('id'));
    if (!deleted.length) return res.status(404).json({ error: 'Category not found' });
    res.json({ ok: true });
  })
);

module.exports = router;
