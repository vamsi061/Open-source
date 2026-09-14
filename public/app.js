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
let categories = [];
let currentProject = null;
let currentRunId = null;
let pollTimer = null;
let editingProjectId = null;
let editingRecipeId = null;
let searchTimer = null;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3200);
}

function mkButton(label, cls, onclick, title) {
  const b = document.createElement('button');
  if (cls) b.className = cls;
  b.textContent = label;
  if (title) b.title = title;
  if (onclick) b.onclick = onclick;
  return b;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- categories ---------- */
async function loadCategories() {
  categories = await api('/categories');
  $('#pf-category').innerHTML =
    '<option value="">— none —</option>' +
    categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('') +
    '<option value="__new__">➕ New category…</option>';
  $('#category-filter').innerHTML =
    '<option value="">All categories</option>' +
    categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
}

/* ---------- projects list ---------- */
async function loadProjects(q = '') {
  projects = await api(`/projects${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  renderList();
}

function renderList() {
  const ul = $('#project-list');
  ul.innerHTML = '';
  const catSel = $('#category-filter').value;
  const shown = catSel ? projects.filter((p) => String(p.category_id) === catSel) : projects;
  $('#project-count').textContent = shown.length || '';
  if (!shown.length) {
    ul.innerHTML = catSel
      ? '<li class="empty">No projects in this category.</li>'
      : '<li class="empty">No projects found.<br>Start with ＋ New project.</li>';
    return;
  }
  for (const p of shown) {
    const li = document.createElement('li');
    li.className = 'project' + (currentProject && currentProject.id === p.id ? ' active' : '');
    const name = document.createElement('div');
    name.className = 'p-name';
    name.textContent = p.name;
    li.appendChild(name);
    if (p.category) {
      const cat = document.createElement('div');
      cat.className = 'p-cat';
      cat.textContent = p.category;
      li.appendChild(cat);
    }
    if (p.purpose || p.description) {
      const purpose = document.createElement('div');
      purpose.className = 'p-purpose';
      purpose.textContent = p.purpose || p.description;
      li.appendChild(purpose);
    }
    if ((p.tags || []).length) {
      const tags = document.createElement('div');
      tags.className = 'p-tags';
      for (const t of p.tags) {
        const s = document.createElement('span');
        s.className = 'tag';
        s.textContent = t;
        tags.appendChild(s);
      }
      li.appendChild(tags);
    }
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

async function renderDetail() {
  const p = currentProject;
  const el = $('#detail');
  el.innerHTML = '';

  // one fetch of recent runs, grouped per recipe for the ribbons / last-run rows
  const byRecipe = {};
  try {
    const ids = new Set((p.recipes || []).map((r) => r.id));
    const runs = await api('/runs?limit=200');
    for (const run of runs) {
      if (ids.has(run.recipe_id)) (byRecipe[run.recipe_id] ||= []).push(run);
    }
  } catch (_) { /* ribbons stay empty */ }

  const head = document.createElement('div');
  head.className = 'd-head';
  const h2 = document.createElement('h2');
  h2.textContent = p.name;
  head.appendChild(h2);
  if (p.category) {
    const cat = document.createElement('span');
    cat.className = 'd-cat';
    cat.textContent = p.category;
    head.appendChild(cat);
  }

  const actions = document.createElement('div');
  actions.className = 'd-actions';
  actions.appendChild(mkButton('Edit', 'ghost', () => openProjectDialog(p)));
  actions.appendChild(mkButton('Delete', 'danger', async () => {
    if (!confirm(`Delete project "${p.name}" and all its recipes and runs?`)) return;
    await api(`/projects/${p.id}`, { method: 'DELETE' });
    currentProject = null;
    $('#detail').innerHTML = '<div class="placeholder">Select a project, or create one</div>';
    loadProjects($('#search').value.trim());
  }));
  head.appendChild(actions);
  el.appendChild(head);

  if (p.purpose) {
    const d = document.createElement('div');
    d.className = 'd-purpose';
    d.textContent = p.purpose;
    el.appendChild(d);
  }
  if (p.repo_url) {
    const repo = document.createElement('div');
    repo.className = 'd-repo';
    const a = document.createElement('a');
    a.href = p.repo_url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = p.repo_url;
    repo.appendChild(a);
    el.appendChild(repo);
  }
  if (p.description) {
    const d = document.createElement('div');
    d.className = 'd-desc';
    d.textContent = p.description;
    el.appendChild(d);
  }
  if ((p.tags || []).length) {
    const tags = document.createElement('div');
    tags.className = 'd-tags';
    for (const t of p.tags) {
      const s = document.createElement('span');
      s.className = 'tag';
      s.textContent = t;
      tags.appendChild(s);
    }
    el.appendChild(tags);
  }

  const sec = document.createElement('section');
  sec.className = 'recipes';
  const h3 = document.createElement('h3');
  h3.appendChild(document.createTextNode('Recipes'));
  h3.appendChild(mkButton('＋ Add recipe', 'primary', () => openRecipeDialog()));
  sec.appendChild(h3);

  if (!p.recipes || !p.recipes.length) {
    const em = document.createElement('div');
    em.className = 'empty';
    em.style.border = '1px dashed var(--line-strong)';
    em.style.borderRadius = '8px';
    em.textContent = 'No recipes yet — save how you run this project.';
    sec.appendChild(em);
  }
  for (const r of p.recipes || []) renderRecipe(sec, r, byRecipe[r.id] || []);
  el.appendChild(sec);
}

function renderRecipe(sec, r, runs) {
  const card = document.createElement('div');
  card.className = 'recipe';

  const top = document.createElement('div');
  top.className = 'r-top';
  const title = document.createElement('span');
  title.className = 'r-title';
  title.textContent = r.title;
  top.appendChild(title);

  // run ribbon: recent history as status squares, oldest → newest left → right
  if (runs.length) {
    const ribbon = document.createElement('span');
    ribbon.className = 'ribbon';
    ribbon.title = `Last ${runs.length} runs, oldest to newest`;
    for (const run of [...runs].reverse()) {
      const sq = document.createElement('i');
      sq.className = run.status;
      ribbon.appendChild(sq);
    }
    top.appendChild(ribbon);
  }

  const spacer = document.createElement('span');
  spacer.className = 'r-spacer';
  top.appendChild(spacer);

  const runBtn = mkButton('▶ Run', 'primary', () => runRecipe(r, runBtn));
  const inputBtn = mkButton('⌨ Input', 'ghost', () => {
    const input = prompt(`Stdin for "${r.title}" — one answer per line:`, '');
    if (input === null) return; // cancelled
    runRecipe(r, inputBtn, input);
  }, 'Run with keyboard input for scripts that prompt via input()/readline()');
  const editBtn = mkButton('Edit', 'ghost', () => openRecipeDialog(r));
  const delBtn = mkButton('✕', 'danger', async () => {
    if (!confirm(`Delete recipe "${r.title}"?`)) return;
    await api(`/recipes/${r.id}`, { method: 'DELETE' });
    selectProject(currentProject.id);
  }, 'Delete recipe');
  top.append(runBtn, inputBtn, editBtn, delBtn);
  card.appendChild(top);

  const cmd = document.createElement('div');
  cmd.className = 'r-cmd';
  const fullCmd = r.args ? `${r.command} ${r.args}` : r.command;
  cmd.textContent = (r.setup ? `$ ${r.setup}\n` : '') + `$ ${fullCmd}`;
  card.appendChild(cmd);

  const meta = document.createElement('div');
  meta.className = 'r-meta';
  if (r.working_dir) {
    const d = document.createElement('span');
    d.textContent = `dir: ${r.working_dir}`;
    meta.appendChild(d);
  }
  if (r.env) {
    const e = document.createElement('span');
    e.textContent = `env: ${String(r.env).replace(/\n/g, ' ')}`;
    meta.appendChild(e);
  }
  // venv toggle — the runner auto-creates .venv in the working dir when on
  const venv = document.createElement('button');
  venv.type = 'button';
  venv.className = 'venv-chip' + (r.use_venv ? ' on' : '');
  venv.textContent = r.use_venv ? 'venv: on' : 'venv: off';
  venv.title = 'Auto-creates .venv in the working dir and activates it before running. Click to toggle.';
  venv.onclick = async () => {
    await api(`/recipes/${r.id}`, { method: 'PUT', body: JSON.stringify({ use_venv: r.use_venv ? 0 : 1 }) });
    selectProject(currentProject.id);
  };
  meta.appendChild(venv);
  card.appendChild(meta);

  const last = document.createElement('div');
  last.className = 'r-last';
  if (!runs.length) {
    last.textContent = 'never run';
  } else {
    const run = runs[0]; // API returns newest first
    last.classList.add('clickable');
    last.title = 'Show output';
    const badge = document.createElement('span');
    badge.className = `badge ${run.status}`;
    badge.textContent = run.status;
    const idSpan = document.createElement('span');
    idSpan.textContent = `run #${run.id}`;
    const timeSpan = document.createElement('span');
    timeSpan.textContent = run.finished_at || run.started_at;
    last.append(badge, idSpan, timeSpan);
    if (run.exit_code !== null && run.exit_code !== undefined) {
      const exitSpan = document.createElement('span');
      exitSpan.textContent = `exit ${run.exit_code}`;
      last.appendChild(exitSpan);
    }
    last.onclick = () => openOutput(run.id, r.title);
  }
  card.appendChild(last);

  sec.appendChild(card);
}

/* ---------- run ---------- */
async function runRecipe(r, btn, input = '') {
  btn.disabled = true;
  try {
    const res = await api(`/recipes/${r.id}/run`, { method: 'POST', body: JSON.stringify({ input }) });
    openOutput(res.run_id, r.title);
  } catch (e) {
    toast(`Run failed: ${e.message}`);
  } finally {
    btn.disabled = false;
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
    out.textContent = run.output || '(no output yet)';
    out.scrollTop = out.scrollHeight;
    setStatus(run.status);
    $('#exit-code').textContent = run.exit_code !== null && run.exit_code !== undefined ? `exit ${run.exit_code}` : '';
    if (run.status === 'running') {
      pollTimer = setTimeout(poll, 1000);
    } else if (currentProject) {
      selectProject(currentProject.id); // refresh ribbons + last-run rows
    }
  } catch (e) {
    setStatus('failed');
    $('#output').textContent = `Error polling run: ${e.message}`;
  }
}

$('#kill-btn').onclick = async () => {
  if (!currentRunId) return;
  try { await api(`/runs/${currentRunId}/kill`, { method: 'POST' }); } catch (_) { /* already done */ }
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
  $('#project-dlg-title').textContent = p ? 'Edit project' : 'New project';
  const f = $('#project-form');
  f.name.value = p ? p.name : '';
  f.repo_url.value = p ? p.repo_url : '';
  f.purpose.value = p ? p.purpose : '';
  f.category_id.value = p && p.category_id ? String(p.category_id) : '';
  f.tags.value = p ? (p.tags || []).join(', ') : '';
  $('#project-dialog').showModal();
}

$('#new-project-btn').onclick = () => openProjectDialog();
$('#project-cancel').onclick = () => $('#project-dialog').close();
$('#pf-category').onchange = async (e) => {
  if (e.target.value !== '__new__') return;
  const name = prompt('New category name:');
  e.target.value = '';
  if (!name || !name.trim()) return;
  try {
    const c = await api('/categories', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    await loadCategories();
    $('#pf-category').value = String(c.id);
    toast(`Category "${c.name}" created`);
  } catch (err) {
    toast(err.message);
  }
};
$('#category-filter').onchange = () => renderList();
$('#project-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    name: f.name.value.trim(),
    repo_url: f.repo_url.value.trim(),
    purpose: f.purpose.value.trim(),
    category_id: f.category_id.value ? Number(f.category_id.value) : null,
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
    toast(err.message);
  }
};

/* ---------- recipe dialog ---------- */
function openRecipeDialog(r = null) {
  editingRecipeId = r ? r.id : null;
  $('#recipe-dlg-title').textContent = r ? 'Edit recipe' : 'New recipe';
  const f = $('#recipe-form');
  f.reset();
  f.title.value = r ? r.title : '';
  f.command.value = r ? r.command : '';
  f.args.value = r ? r.args || '' : '';
  f.setup.value = r ? r.setup || '' : '';
  f.working_dir.value = r ? r.working_dir || '' : '';
  f.env.value = r ? r.env || '' : '';
  f.use_venv.checked = r ? !!r.use_venv : false;
  $('#recipe-dialog').showModal();
}

$('#recipe-cancel').onclick = () => { editingRecipeId = null; $('#recipe-dialog').close(); };
$('#recipe-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    title: f.title.value.trim(),
    command: f.command.value.trim(),
    args: f.args.value.trim(),
    setup: f.setup.value.trim(),
    working_dir: f.working_dir.value.trim(),
    env: f.env.value,
    use_venv: f.use_venv.checked ? 1 : 0,
  };
  try {
    if (editingRecipeId) {
      await api(`/recipes/${editingRecipeId}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      await api('/recipes', { method: 'POST', body: JSON.stringify({ ...body, project_id: currentProject.id }) });
    }
    $('#recipe-dialog').close();
    f.reset();
    editingRecipeId = null;
    selectProject(currentProject.id);
  } catch (err) {
    toast(err.message);
  }
};

/* ---------- search ---------- */
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadProjects(e.target.value.trim()), 250);
});

/* ---------- init ---------- */
loadProjects();
loadCategories();
