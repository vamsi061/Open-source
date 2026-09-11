const { spawn } = require('child_process');
const db = require('../db/database');
const venv = require('./venv');

const MAX_OUTPUT = 200000; // chars kept in DB
const MAX_INPUT = 65536; // chars of stdin accepted per run
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

function runRecipe(recipe, opts = {}, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  const input = typeof opts.input === 'string' ? opts.input.slice(0, MAX_INPUT) : '';
  // args: per-run override wins, else the recipe's stored args. Appended to the command line.
  const args = (typeof opts.args === 'string' ? opts.args : (recipe.args || '')).slice(0, MAX_INPUT);
  const info = db.prepare('INSERT INTO runs (recipe_id, status, input, args) VALUES (?, ?, ?, ?)').run(recipe.id, 'running', input, args);
  const runId = info.lastInsertRowid;
  const cwd = recipe.working_dir || recipe.project_working_dir || process.cwd();

  // chain: optional setup (e.g. npm install) then command(s), in one shell.
  // command may hold multiple lines — bash runs them sequentially.
  const fullCommand = args ? `${recipe.command} ${args}` : recipe.command;
  let script = recipe.setup ? `${recipe.setup}\n${fullCommand}` : fullCommand;

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

  // Stdin: pipe the provided input (if any), then always EOF.
  // An open-but-silent stdin makes input()/readline() block forever, leaving
  // the run stuck in 'running' — closing it turns that into a fast failure.
  if (child.stdin) {
    child.stdin.on('error', () => {}); // swallow EPIPE when the child exits unread
    if (input) child.stdin.write(input.endsWith('\n') ? input : input + '\n');
    child.stdin.end();
  }

  let output = '';
  const append = (chunk) => {
    output += chunk;
    if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  child.on('close', (code) => {
    running.delete(runId);
    if (!input && code !== 0 && /EOF when reading a line|EOFError/.test(output)) {
      output += "\n[repovault hint] The script waited for keyboard input but stdin was empty (EOF). Re-run with the ⌨ button to type the answers, or bake them into the command as arguments.";
    }
    if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
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
