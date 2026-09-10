const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ensure a python3 venv exists in the given dir (named .venv); returns its path
function ensureVenv(dir) {
  const venvPath = path.join(dir, '.venv');
  if (!fs.existsSync(path.join(venvPath, 'bin', 'activate'))) {
    execFileSync('python3', ['-m', 'venv', venvPath], { cwd: dir, stdio: 'pipe' });
  }
  return venvPath;
}

module.exports = { ensureVenv };
