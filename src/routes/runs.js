const express = require('express');
const router = express.Router();
const { killRun, getRun, listRuns } = require('../services/runner');

// GET /api/runs?recipe_id=&status=&limit=
// NOTE: run history is kept in server memory only (not persisted) — it resets on restart.
router.get('/', (req, res) => {
  res.json(
    listRuns({
      recipe_id: req.query.recipe_id,
      status: req.query.status,
      limit: Math.min(parseInt(req.query.limit) || 50, 200),
    })
  );
});

// GET /api/runs/:id - poll a run's status/output
router.get('/:id', (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
});

// POST /api/runs/:id/kill
router.post('/:id/kill', (req, res) => {
  if (!killRun(req.params.id)) return res.status(404).json({ error: 'Run is not active or not found' });
  res.json({ ok: true });
});

module.exports = router;
