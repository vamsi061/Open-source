const { spawn } = require('child_process');
const venv = require('./venv');

const MAX_OUTPUT = 200000; // chars kept in memory
const MAX_INPUT = 65536; // chars of stdin accepted per run
const MAX_HISTORY = 500; // run records kept in memory (not persisted anywhere)
const running = new Map(); // runId -> child process
const history = []; // newest-first in-memory run records; cleared on restart
let nextRunId = 1;

// parse "KEY=value" lines into an object
function parseEnv(str) {
  const out = {};
  for (const line of String(str).split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// create an in-memory record for a new run (run history is not persisted)
function newRunRecord(recipe, input, args) {
  const rec = {
    id: nextRunId++,
    recipe_id: recipe.id,
    recipe_title: recipe.title,
    command: recipe.command,
    status: 'running',
    exit_code: null,
    output: '',
    input,
    args,
    started_at: new Date().toISOString(),
    finished_at: null,
  };
  history.unshift(rec);
  if (history.length > MAX_HISTORY) history.pop();
  return rec;
}

function runRecipe(recipe, opts = {}, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  const input = typeof opts.input === 'string' ? opts.input.slice(0, MAX_INPUT) : '';
  // args: per-run override wins, else the recipe's stored args. Appended to the command line.
  const args = (typeof opts.args === 'string' ? opts.args : (recipe.args || '')).slice(0, MAX_INPUT);
  const rec = newRunRecord(recipe, input, args);
  const runId = rec.id;
  // priority: recipe's explicit working_dir > auto-cloned project repo > server dir
  const cwd = recipe.working_dir || opts.cwd || process.cwd();
  rec.output = `[repovault] dir: ${cwd}\n`;

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

  const append = (chunk) => {
    rec.output += chunk;
    if (rec.output.length > MAX_OUTPUT) rec.output = rec.output.slice(-MAX_OUTPUT);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  child.on('close', (code) => {
    running.delete(runId);
    if (!input && code !== 0 && /EOF when reading a line|EOFError/.test(rec.output)) {
      rec.output += "\n[repovault hint] The script waited for keyboard input but stdin was empty (EOF). Re-run with the ⌨ button to type the answers, or bake them into the command as arguments.";
    }
    if (rec.output.length > MAX_OUTPUT) rec.output = rec.output.slice(-MAX_OUTPUT);
    rec.status = code === 0 ? 'success' : 'failed';
    rec.exit_code = code;
    rec.finished_at = new Date().toISOString();
    if (cb) cb(runId, code);
  });

  child.on('error', (err) => {
    running.delete(runId);
    rec.status = 'failed';
    rec.exit_code = -1;
    rec.output = String(err);
    rec.finished_at = new Date().toISOString();
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

function getRun(id) {
  return history.find((r) => r.id === Number(id)) || null;
}

// filterable history: ?recipe_id=&status=&limit= (newest first)
function listRuns({ recipe_id, status, limit = 50 } = {}) {
  return history
    .filter((r) =>
      (recipe_id === undefined || r.recipe_id === Number(recipe_id)) &&
      (status === undefined || r.status === status)
    )
    .slice(0, Math.max(1, Number(limit) || 50));
}

function latestRunningForRecipe(recipeId) {
  return history.find((r) => r.recipe_id === Number(recipeId) && r.status === 'running') || null;
}

module.exports = { runRecipe, killRun, getRun, listRuns, latestRunningForRecipe };
