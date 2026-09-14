const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { q } = require('../db/database');
const { runRecipe, killRun, latestRunningForRecipe } = require('../services/runner');
const { ensureRepo } = require('../services/repos');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// GET all recipes (optionally by project)
router.get(
  '/',
  wrap(async (req, res) => {
    let query = db.from('recipes').select('*').order('id');
    if (req.query.project_id) query = query.eq('project_id', req.query.project_id);
    res.json(await q(query));
  })
);

// POST /api/recipes { project_id, title, command, args, setup, working_dir, env, use_venv }
// command may hold multiple lines — they run sequentially. args is appended to the command line.
router.post(
  '/',
  wrap(async (req, res) => {
    const {
      project_id,
      title,
      command,
      args = '',
      setup = '',
      working_dir = '',
      env = '',
      use_venv = 0,
    } = req.body || {};
    if (!project_id || !title || !command)
      return res.status(400).json({ error: 'project_id, title, command are required' });
    const project = await q(db.from('projects').select('id').eq('id', project_id).limit(1));
    if (!project.length) return res.status(404).json({ error: 'Project not found' });
    const recipe = await q(
      db
        .from('recipes')
        .insert({
          project_id,
          title,
          command,
          args,
          setup,
          working_dir,
          env,
          use_venv: use_venv ? 1 : 0,
        })
        .select()
        .single()
    );
    res.status(201).json(recipe);
  })
);

// PUT /api/recipes/:id
router.put(
  '/:id',
  wrap(async (req, res) => {
    const rows = await q(db.from('recipes').select('*').eq('id', req.params.id).limit(1));
    if (!rows.length) return res.status(404).json({ error: 'Recipe not found' });
    const row = rows[0];
    const { title, command, args, setup, working_dir, env, use_venv } = req.body || {};
    const recipe = await q(
      db
        .from('recipes')
        .update({
          title: title ?? row.title,
          command: command ?? row.command,
          args: args ?? (row.args ?? ''),
          setup: setup ?? row.setup,
          working_dir: working_dir ?? row.working_dir,
          env: env ?? row.env,
          use_venv: use_venv === undefined ? (row.use_venv ?? 0) : use_venv ? 1 : 0,
        })
        .eq('id', req.params.id)
        .select()
        .single()
    );
    res.json(recipe);
  })
);

// DELETE /api/recipes/:id
router.delete(
  '/:id',
  wrap(async (req, res) => {
    const deleted = await q(db.from('recipes').delete().eq('id', req.params.id).select('id'));
    if (!deleted.length) return res.status(404).json({ error: 'Recipe not found' });
    res.json({ ok: true });
  })
);

// POST /api/recipes/:id/run  - one-click execution. Body: { input?, args? }
// input = stdin text for interactive scripts; args overrides the recipe's stored args for this run only.
router.post(
  '/:id/run',
  wrap(async (req, res) => {
    const rows = await q(db.from('recipes').select('*').eq('id', req.params.id).limit(1));
    if (!rows.length) return res.status(404).json({ error: 'Recipe not found' });
    const recipe = rows[0];
    const body = req.body || {};
    const input = typeof body.input === 'string' ? body.input : '';
    const opts = { input };
    if (typeof body.args === 'string') opts.args = body.args;
    // default working directory: the project's repo, cloned/updated automatically
    if (!recipe.working_dir) {
      const proj = await q(
        db.from('projects').select('id, name, repo_url').eq('id', recipe.project_id).limit(1)
      );
      const repoDir = await ensureRepo(proj[0]);
      if (repoDir) opts.cwd = repoDir;
    }
    const { runId } = runRecipe(recipe, opts);
    res.status(202).json({ run_id: runId, status: 'running', poll: `/api/runs/${runId}` });
  })
);

// POST /api/recipes/:id/kill - stop a running execution of this recipe (latest run)
router.post(
  '/:id/kill',
  wrap(async (req, res) => {
    const latest = latestRunningForRecipe(req.params.id);
    if (!latest)
      return res.status(404).json({ error: 'No running execution for this recipe' });
    res.json({ ok: killRun(latest.id) });
  })
);

module.exports = router;
