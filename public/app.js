/* RepoVault frontend */
const $ = (sel) => document.querySelector(sel);
const api = (path, opts = {}) =>
  fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  }).then((r) => {
    if (!r.ok) return r.json().then((e) => Promise.reject(new Error(e.error || r.statusText)));
    return r.json();
  });

let projects = [];
let currentProject = null;
let currentRunId = null;
let pollTimer = null;
let editingProjectId = null;

/* ---------- projects list ---------- */
async function loadProjects(q = '') {
  projects = await api(`/projects${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  renderList();
}

function renderList() {
  const ul = $('#project-list');
  ul.innerHTML = '';
  if (!projects.length) {
    ul.innerHTML = '<li class="empty">No projects found.<br>Create one with ＋ New Project</li>';
    return;
  }
  for (const p of projects) {
    const li = document.createElement('li');
    li.className = `project${currentProject && currentProject.id === p.id ? ' active' : ''}`;
    li.innerHTML = `
      <div class="p-name"></div>
      <div class="p-purpose"></div>
      <div class="p-tags"></div>`;
    li.querySelector('.p-name').textContent = p.name;
    li.querySelector('.p-purpose').textContent = p.purpose || p.description || '';
    const tags = li.querySelector('.p-tags');
    (p.tags || []).forEach((t) => {
      const s = document.createElement('span');
      s.className = 'tag';
      s.textContent = t;
      tags.appendChild(s);
    });
    li.onclick = () => selectProject(p.id);
    ul.appendChild(li);
  }
}

/* ---------- project detail ---------- */
async function selectProject(id) {
  currentProject = await api(`/projects/${id}`);
  renderList();
  renderDetail();
}

function renderDetail() {
  const p = currentProject;
  const el = $('#detail');
  el.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'd-head';
  const h2 = document.createElement('h2');
  h2.textContent = p.name;
  head.appendChild(h2);

  const actions = document.createElement('div');
  actions.className = 'd-actions';
  const editBtn = document.createElement('button');
  editBtn.className = 'secondary';
  editBtn.textContent = 'Edit';
  editBtn.onclick = () => openProjectDialog(p);
  const delBtn = document.createElement('button');
  delBtn.className = 'danger';
  delBtn.textContent = 'Delete';
  delBtn.onclick = async () => {
    if (!confirm(`Delete project "${p.name}" and all its recipes/runs?`)) return;
    await api(`/projects/${p.id}`, { method: 'DELETE' });
    currentProject = null;
    $('#detail').innerHTML = '<div class="placeholder">Select a project, or create one</div>';
    loadProjects($('#search').value.trim());
  };
  actions.append(editBtn, delBtn);
  head.appendChild(actions);
  el.appendChild(head);

  if (p.purpose) {
    const pu = document.createElement('div');
    pu.className = 'd-purpose';
    pu.textContent = `Purpose: ${p.purpose}`;
    el.appendChild(pu);
  }
  if (p.repo_url) {
    const repo = document.createElement('div');
    repo.className = 'd-repo';
    const a = document.createElement('a');
    a.href = p.repo_url;
    a.target = '_blank';
    a.textContent = p.repo_url;
    repo.appendChild(a);
    el.appendChild(repo);
  }
  if (p.description) {
    const de = document.createElement('div');
    de.className = 'd-purpose';
    de.textContent = p.description;
    el.appendChild(de);
  }

  const sec = document.createElement('section');
  sec.className = 'recipes';
  const h3 = document.createElement('h3');
  h3.textContent = 'Recipes (how to run it)';
  const addBtn = document.createElement('button');
  addBtn.textContent = '＋ Add Recipe';
  addBtn.onclick = () => $('#recipe-dialog').showModal();
  h3.appendChild(addBtn);
  sec.appendChild(h3);

  if (!p.recipes || !p.recipes.length) {
    const em = document.createElement('div');
    em.className = 'empty';
    em.textContent = 'No recipes yet — save how you run this project.';
    sec.appendChild(em);
  }
  for (const r of p.recipes || []) renderRecipe(sec, r);
  el.appendChild(sec);
}

function renderRecipe(sec, r) {
  const card = document.createElement('div');
  card.className = 'recipe';
  card.dataset.recipeId = r.id;

  const top = document.createElement('div');
  top.className = 'r-top';
  const title = document.createElement('span');
  title.className = 'r-title';
  title.textContent = r.title;
  const runBtn = document.createElement('button');
  runBtn.textContent = '▶ Run';
  runBtn.onclick = () => runRecipe(r, runBtn);
  const delBtn = document.createElement('button');
  delBtn.className = 'danger';
  delBtn.textContent = '✕';
  delBtn.title = 'Delete recipe';
  delBtn.onclick = async () => {
    if (!confirm(`Delete recipe "${r.title}"?`)) return;
    await api(`/recipes/${r.id}`, { method: 'DELETE' });
    selectProject(currentProject.id);
  };
  top.append(title, runBtn, delBtn);
  card.appendChild(top);

  const cmd = document.createElement('div');
  cmd.className = 'r-cmd';
  cmd.textContent = `$ ${r.setup ? r.setup + '\n' : ''}${r.command}`;
  card.appendChild(cmd);

  const meta = [];
  if (r.working_dir) meta.push(`dir: ${r.working_dir}`);
  if (r.env) meta.push(`env: ${r.env.replace(/\n/g, ' ')}`);
  if (meta.length) {
    const m = document.createElement('div');
    m.className = 'r-meta';
    m.textContent = meta.join('  ·  ');
    card.appendChild(m);
  }

  // venv badge + toggle button
  const venvRow = document.createElement('div');
  venvRow.style.cssText = 'margin-top:8px;display:flex;align-items:center;gap:8px';
  const venvBadge = document.createElement('span');
  venvBadge.className = 'tag';
  venvBadge.textContent = '🐍 venv: ' + (r.use_venv ? 'ON' : 'off');
  venvBadge.style.cursor = 'pointer';
  venvBadge.title = 'Click to toggle venv for this recipe';
  venvBadge.onclick = async () => {
    await api(`/recipes/${r.id}`, { method: 'PUT', body: JSON.stringify({ use_venv: !r.use_venv }) });
    selectProject(currentProject.id);
  };
  const venvSetupBtn = document.createElement('button');
  venvSetupBtn.className = 'secondary';
  venvSetupBtn.style.padding = '4px 10px';
  venvSetupBtn.style.fontSize = '12px';
  venvSetupBtn.textContent = '🐍 Setup venv + install requirements';
  venvSetupBtn.title = 'Creates .venv in the working dir and runs pip install -r requirements.txt';
  venvSetupBtn.onclick = () => venvSetup(r, venvSetupBtn);
  venvRow.append(venvBadge, venvSetupBtn);
  card.appendChild(venvRow);

  const last = document.createElement('div');
  last.className = 'r-last';
  last.textContent = 'loading last run…';
  card.appendChild(last);
  api(`/runs?recipe_id=${r.id}&limit=1`).then((runs) => {
    if (!runs.length) { last.textContent = 'never run'; return; }
    const run = runs[0];
    last.innerHTML = '';
    const badge = document.createElement('span');
    badge.className = `badge ${run.status}`;
    badge.textContent = run.status;
    last.append(badge, document.createTextNode(`  run #${run.id} · ${run.finished_at || run.started_at}${run.exit_code !== null && run.exit_code !== undefined ? ' · exit ' + run.exit_code : ''}`));
    last.style.cursor = 'pointer';
    last.title = 'Click to view output';
    last.onclick = () => openOutput(run.id);
  }).catch(() => { last.textContent = ''; });

  sec.appendChild(card);
}

/* ---------- venv setup ---------- */
async function venvSetup(r, btn) {
  btn.disabled = true;
  try {
    // one-off run: create venv if missing, then pip install requirements if present
    const body = JSON.stringify({
      title: `[venv setup] ${r.title}`,
      command: 'if [ -f requirements.txt ]; then pip install -r requirements.txt; else echo "no requirements.txt found"; fi',
      setup: '',
      working_dir: r.working_dir || '',
      env: r.env || '',
    });
    // ensure use_venv is on so the runner creates/activates the venv
    if (!r.use_venv) await api(`/recipes/${r.id}`, { method: 'PUT', body: JSON.stringify({ use_venv: 1 }) });
    const res = await api(`/recipes/${r.id}/run`, { method: 'POST' });
    openOutput(res.run_id, `venv setup: ${r.title}`);
  } catch (e) {
    alert(`venv setup failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    if (currentProject) selectProject(currentProject.id);
  }
}

/* ---------- run ---------- */
async function runRecipe(r, btn) {
  btn.disabled = true;
  try {
    const res = await api(`/recipes/${r.id}/run`, { method: 'POST' });
    openOutput(res.run_id, r.title);
  } catch (e) {
    alert(`Run failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    if (currentProject) selectProject(currentProject.id);
  }
}

function openOutput(runId, title) {
  currentRunId = runId;
  $('#output-title').textContent = title ? `Run: ${title}` : `Run #${runId}`;
  $('#output').textContent = '';
  $('#exit-code').textContent = '';
  setStatus('running');
  $('#output-panel').classList.add('open');
  poll();
}

function setStatus(s) {
  const b = $('#run-status');
  b.className = `badge ${s}`;
  b.textContent = s;
  $('#kill-btn').style.display = s === 'running' ? '' : 'none';
}

async function poll() {
  clearTimeout(pollTimer);
  if (!currentRunId) return;
  try {
    const run = await api(`/runs/${currentRunId}`);
    const out = $('#output');
    if (run.recipe_title && !$('#output-title').textContent.startsWith('Run: ')) {
      $('#output-title').textContent = `Run: ${run.recipe_title}`;
    }
    out.textContent = run.output || '(no output yet)';
    out.scrollTop = out.scrollHeight;
    setStatus(run.status);
    $('#exit-code').textContent = run.exit_code !== null && run.exit_code !== undefined ? `exit ${run.exit_code}` : '';
    if (run.status === 'running') pollTimer = setTimeout(poll, 1000);
    else if (currentProject) selectProject(currentProject.id); // refresh last-run badges
  } catch (e) {
    setStatus('failed');
    $('#output').textContent = `Error polling run: ${e.message}`;
  }
}

$('#kill-btn').onclick = async () => {
  if (!currentRunId) return;
  try { await api(`/runs/${currentRunId}/kill`, { method: 'POST' }); } catch (e) { /* already done */ }
  poll();
};
$('#close-output').onclick = () => {
  $('#output-panel').classList.remove('open');
  currentRunId = null;
  clearTimeout(pollTimer);
};

/* ---------- project dialog ---------- */
function openProjectDialog(p = null) {
  editingProjectId = p ? p.id : null;
  $('#project-dlg-title').textContent = p ? 'Edit Project' : 'New Project';
  const f = $('#project-form');
  f.name.value = p ? p.name : '';
  f.repo_url.value = p ? p.repo_url : '';
  f.purpose.value = p ? p.purpose : '';
  f.tags.value = p ? (p.tags || []).join(', ') : '';
  $('#project-dialog').showModal();
}

$('#new-project-btn').onclick = () => openProjectDialog();
$('#project-cancel').onclick = () => $('#project-dialog').close();
$('#project-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    name: f.name.value.trim(),
    repo_url: f.repo_url.value.trim(),
    purpose: f.purpose.value.trim(),
    tags: f.tags.value.split(',').map((t) => t.trim()).filter(Boolean),
  };
  try {
    if (editingProjectId) {
      await api(`/projects/${editingProjectId}`, { method: 'PUT', body: JSON.stringify(body) });
      $('#project-dialog').close();
      await loadProjects($('#search').value.trim());
      selectProject(editingProjectId);
    } else {
      const created = await api('/projects', { method: 'POST', body: JSON.stringify(body) });
      $('#project-dialog').close();
      await loadProjects($('#search').value.trim());
      selectProject(created.id);
    }
  } catch (err) {
    alert(err.message);
  }
};

/* ---------- recipe dialog ---------- */
$('#recipe-cancel').onclick = () => $('#recipe-dialog').close();
$('#recipe-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    project_id: currentProject.id,
    title: f.title.value.trim(),
    command: f.command.value.trim(),
    setup: f.setup.value.trim(),
    working_dir: f.working_dir.value.trim(),
    env: f.env.value,
    use_venv: f.use_venv.checked ? 1 : 0,
  };
  try {
    await api('/recipes', { method: 'POST', body: JSON.stringify(body) });
    $('#recipe-dialog').close();
    f.reset();
    selectProject(currentProject.id);
  } catch (err) {
    alert(err.message);
  }
};

/* ---------- search ---------- */
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadProjects(e.target.value.trim()), 250);
});

/* ---------- init ---------- */
loadProjects();
