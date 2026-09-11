const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { runRecipe, killRun } = require('../services/runner');

function getRecipeFull(id) {
  return db.prepare('SELECT * FROM recipes WHERE id = ?').get(id);
}

// GET all recipes (optionally by project)
router.get('/', (req, res) => {
  const rows = req.query.project_id
    ? db.prepare('SELECT * FROM recipes WHERE project_id = ? ORDER BY id').all(req.query.project_id)
    : db.prepare('SELECT * FROM recipes ORDER BY id').all();
  res.json(rows);
});

// POST /api/recipes { project_id, title, command, args, setup, working_dir, env, use_venv }
// command may hold multiple lines — they run sequentially. args is appended to the command line.
router.post('/', (req, res) => {
  const { project_id, title, command, args = '', setup = '', working_dir = '', env = '', use_venv = 0 } = req.body || {};
  if (!project_id || !title || !command) return res.status(400).json({ error: 'project_id, title, command are required' });
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(project_id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const info = db.prepare('INSERT INTO recipes (project_id, title, command, args, setup, working_dir, env, use_venv) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(project_id, title, command, args, setup, working_dir, env, use_venv ? 1 : 0);
  res.status(201).json(db.prepare('SELECT * FROM recipes WHERE id = ?').get(info.lastInsertRowid));
});

// PUT /api/recipes/:id
router.put('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM recipes WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Recipe not found' });
  const { title, command, args, setup, working_dir, env, use_venv } = req.body || {};
  db.prepare('UPDATE recipes SET title = ?, command = ?, args = ?, setup = ?, working_dir = ?, env = ?, use_venv = ? WHERE id = ?')
    .run(title ?? row.title, command ?? row.command, args ?? (row.args ?? ''), setup ?? row.setup, working_dir ?? row.working_dir, env ?? row.env,
      use_venv === undefined ? (row.use_venv ?? 0) : (use_venv ? 1 : 0), req.params.id);
  res.json(db.prepare('SELECT * FROM recipes WHERE id = ?').get(req.params.id));
});

// DELETE /api/recipes/:id
router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM recipes WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Recipe not found' });
  res.json({ ok: true });
});

// POST /api/recipes/:id/run  - one-click execution. Body: { input?, args? }
// input = stdin text for interactive scripts; args overrides the recipe's stored args for this run only.
router.post('/:id/run', (req, res) => {
  const recipe = getRecipeFull(req.params.id);
  if (!recipe) return res.status(404).json({ error: 'Recipe not found' });
  const body = req.body || {};
  const input = typeof body.input === 'string' ? body.input : '';
  const opts = { input };
  if (typeof body.args === 'string') opts.args = body.args;
  const { runId } = runRecipe(recipe, opts);
  res.status(202).json({ run_id: runId, status: 'running', poll: `/api/runs/${runId}` });
});

// POST /api/recipes/:id/kill - stop a running execution of this recipe (latest run)
router.post('/:id/kill', (req, res) => {
  const latest = db.prepare("SELECT id FROM runs WHERE recipe_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1").get(req.params.id);
  if (!latest) return res.status(404).json({ error: 'No running execution for this recipe' });
  res.json({ ok: killRun(latest.id) });
});

module.exports = router;
