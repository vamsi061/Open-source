const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { killRun } = require('../services/runner');

// GET /api/runs?recipe_id=&status=&limit=
router.get('/', (req, res) => {
  const { recipe_id, status } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  let rows;
  if (recipe_id && status) {
    rows = db.prepare('SELECT * FROM runs WHERE recipe_id = ? AND status = ? ORDER BY id DESC LIMIT ?').all(recipe_id, status, limit);
  } else if (recipe_id) {
    rows = db.prepare('SELECT * FROM runs WHERE recipe_id = ? ORDER BY id DESC LIMIT ?').all(recipe_id, limit);
  } else if (status) {
    rows = db.prepare('SELECT * FROM runs WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit);
  } else {
    rows = db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit);
  }
  res.json(rows);
});

// GET /api/runs/:id - poll a run's status/output
router.get('/:id', (req, res) => {
  const row = db.prepare(`
    SELECT r.*, re.title AS recipe_title, re.command FROM runs r
    JOIN recipes re ON re.id = r.recipe_id WHERE r.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Run not found' });
  res.json(row);
});

// POST /api/runs/:id/kill
router.post('/:id/kill', (req, res) => {
  if (!killRun(req.params.id)) return res.status(404).json({ error: 'Run is not active or not found' });
  res.json({ ok: true });
});

module.exports = router;
