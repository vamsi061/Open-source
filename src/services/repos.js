// Auto-managed local clones of project repos.
// When a recipe has no working_dir, its project's repo is cloned (first run)
// and updated (later runs) into data/repos/<project-id>-<slug>, and that
// directory becomes the default working directory.
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs');
const path = require('path');

// clones live next to the app's data dir (gitignored); override with REPOVAULT_REPO_DIR
const REPO_ROOT = process.env.REPOVAULT_REPO_DIR || path.join(__dirname, '..', '..', 'data', 'repos');
const CLONE_TIMEOUT_MS = 120 * 1000;
const PULL_TIMEOUT_MS = 20 * 1000;
const RETRY_MS = 10 * 60 * 1000; // wait before re-attempting a failed clone
const failedAt = new Map(); // repo_url -> ts of last failed clone

function slugify(name) {
  return (
    String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'repo'
  );
}

function isRepoUrl(url) {
  return /^(https?:\/\/|git@)/.test(String(url || '').trim());
}

function dirFor(project) {
  return path.join(REPO_ROOT, `${project.id}-${slugify(project.name)}`);
}

// Resolves the local clone for a project: clones if missing, pulls otherwise.
// Returns the directory, or null when there is nothing to clone / clone failed
// (the caller then falls back to its own default).
async function ensureRepo(project) {
  if (process.env.REPOVAULT_SKIP_REPO_SYNC === '1') return null; // used by tests
  if (!project || !isRepoUrl(project.repo_url)) return null;
  const dir = dirFor(project);

  if (fs.existsSync(path.join(dir, '.git'))) {
    try {
      await execFileAsync('git', ['-C', dir, 'pull', '--ff-only', '--quiet'], {
        timeout: PULL_TIMEOUT_MS,
      });
    } catch (_) {
      // offline or dirty tree — run with the copy we already have
    }
    return dir;
  }

  if (Date.now() - (failedAt.get(project.repo_url) || 0) < RETRY_MS) return null; // recently failed
  try {
    fs.mkdirSync(REPO_ROOT, { recursive: true });
    await execFileAsync('git', ['clone', '--depth', '1', String(project.repo_url).trim(), dir], {
      timeout: CLONE_TIMEOUT_MS,
    });
    return dir;
  } catch (err) {
    failedAt.set(project.repo_url, Date.now());
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
    return null;
  }
}

module.exports = { ensureRepo, dirFor, REPO_ROOT };
