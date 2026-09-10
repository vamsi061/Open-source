const express = require('express');
const router = express.Router();
const db = require('../db/database');

// GET /api/projects?q=  - search by name/description/purpose/repo
router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  let rows;
  if (q) {
    const like = `%${q}%`;
    rows = db.prepare(`
      SELECT DISTINCT p.* FROM projects p
      LEFT JOIN project_tags pt ON pt.project_id = p.id
      LEFT JOIN tags t ON t.id = pt.tag_id
      WHERE p.name LIKE ? OR p.description LIKE ? OR p.purpose LIKE ? OR p.repo_url LIKE ? OR t.name LIKE ?
      ORDER BY p.name
    `).all(like, like, like, like, like);
  } else {
    rows = db.prepare('SELECT * FROM projects ORDER BY name').all();
  }
  const tagStmt = db.prepare('SELECT t.name FROM tags t JOIN project_tags pt ON pt.tag_id = t.id WHERE pt.project_id = ?');
  res.json(rows.map(r => ({ ...r, tags: tagStmt.all(r.id).map(x => x.name) })));
});

// GET /api/projects/:id
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Project not found' });
  const tags = db.prepare('SELECT t.name FROM tags t JOIN project_tags pt ON pt.tag_id = t.id WHERE pt.project_id = ?').all(row.id).map(x => x.name);
  const recipes = db.prepare('SELECT id, title, command, setup, env FROM recipes WHERE project_id = ?').all(row.id);
  res.json({ ...row, tags, recipes });
});

// POST /api/projects  { name, repo_url, description, purpose, tags: [] }
router.post('/', (req, res) => {
  const { name, repo_url = '', description = '', purpose = '', tags = [] } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const info = db.prepare('INSERT INTO projects (name, repo_url, description, purpose) VALUES (?, ?, ?, ?)').run(name, repo_url, description, purpose);
  const id = info.lastInsertRowid;
  const insTag = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
  const insPT = db.prepare('INSERT OR IGNORE INTO project_tags (project_id, tag_id) SELECT ?, id FROM tags WHERE name = ?');
  for (const t of tags) { insTag.run(t); insPT.run(id, t); }
  res.status(201).json(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
});

// PUT /api/projects/:id
router.put('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Project not found' });
  const { name, repo_url, description, purpose, tags } = req.body || {};
  db.prepare('UPDATE projects SET name = ?, repo_url = ?, description = ?, purpose = ? WHERE id = ?')
    .run(name ?? row.name, repo_url ?? row.repo_url, description ?? row.description, purpose ?? row.purpose, req.params.id);
  if (Array.isArray(tags)) {
    db.prepare('DELETE FROM project_tags WHERE project_id = ?').run(req.params.id);
    const insTag = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
    const insPT = db.prepare('INSERT OR IGNORE INTO project_tags (project_id, tag_id) SELECT ?, id FROM tags WHERE name = ?');
    for (const t of tags) { insTag.run(t); insPT.run(req.params.id, t); }
  }
  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id));
});

// DELETE /api/projects/:id
router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Project not found' });
  res.json({ ok: true });
});

module.exports = router;
