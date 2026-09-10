const { spawn } = require('child_process');
const db = require('../db/database');
const venv = require('./venv');

const MAX_OUTPUT = 200000; // chars kept in DB
const running = new Map(); // runId -> child process

// parse "KEY=value" lines into an object
function parseEnv(str) {
  const out = {};
  for (const line of String(str).split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function runRecipe(recipe, cb) {
  const info = db.prepare('INSERT INTO runs (recipe_id, status) VALUES (?, ?)').run(recipe.id, 'running');
  const runId = info.lastInsertRowid;
  const cwd = recipe.working_dir || recipe.project_working_dir || process.cwd();

  // chain: optional setup (e.g. npm install) then command, in one shell
  let script = recipe.setup ? `${recipe.setup}\n${recipe.command}` : recipe.command;

  // if venv requested, create it if missing and activate for the script
  if (recipe.use_venv) {
    const venvPath = venv.ensureVenv(cwd);
    script = `source '${venvPath}/bin/activate'\n${script}`;
  }

  const child = spawn('/bin/bash', ['-c', script], {
    cwd,
    env: { ...process.env, PYTHONUNBUFFERED: '1', ...(recipe.env ? parseEnv(recipe.env) : {}) },
  });
  running.set(runId, child);

  let output = '';
  const append = (chunk) => {
    output += chunk;
    if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  child.on('close', (code) => {
    running.delete(runId);
    db.prepare('UPDATE runs SET status = ?, exit_code = ?, output = ?, finished_at = datetime(\'now\') WHERE id = ?')
      .run(code === 0 ? 'success' : 'failed', code, output, runId);
    if (cb) cb(runId, code);
  });

  child.on('error', (err) => {
    running.delete(runId);
    db.prepare('UPDATE runs SET status = ?, exit_code = ?, output = ?, finished_at = datetime(\'now\') WHERE id = ?')
      .run('failed', -1, String(err), runId);
    if (cb) cb(runId, -1);
  });

  return { runId, child };
}

function killRun(runId) {
  const child = running.get(Number(runId));
  if (!child) return false;
  child.kill('SIGTERM');
  return true;
}

// on startup, mark orphaned runs from previous process as failed
function recoverOrphans() {
  db.prepare("UPDATE runs SET status = 'failed', exit_code = -1, output = COALESCE(output, '') || '\n[interrupted: server restarted]', finished_at = datetime('now') WHERE status = 'running'").run();
}

module.exports = { runRecipe, killRun, recoverOrphans };
