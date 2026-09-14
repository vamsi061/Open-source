/* RepoVault frontend — JARVIS console edition */
const $ = (sel) => document.querySelector(sel);

const api = (path, opts = {}) => {
  // per-call timeout override: first run on a fresh device clones the repo and
  // builds the venv inside POST /recipes/:id/run, which can take minutes
  const { timeout = 8000 } = opts;
  const attempt = (retry) =>
    fetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeout), ...opts }).then((r) => {
      if (!r.ok) return r.json().then((e) => Promise.reject(new Error(e.error || r.statusText)));
      return r.json();
    }).catch((err) => {
      // network stall / dead keep-alive socket → one silent retry, then surface
      if (retry && !(err instanceof SyntaxError)) {
        return new Promise((res) => setTimeout(res, 400)).then(() => attempt(false));
      }
      throw err;
    });
  return attempt(true);
};

let projects = [];
let categories = [];
let currentProject = null;
let currentRunId = null;
let pollTimer = null;
let editingProjectId = null;
let editingRecipeId = null;
let searchTimer = null;
let currentCategory = null; // null = dashboard, id = category view, 'none' = uncategorized
let searchMode = false;
let searchQuery = '';
let lastOutputRun = null; // { id, title } — lets a shell re-open after view switches

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

const catName = (id) => (categories.find((c) => String(c.id) === String(id)) || {}).name || null;

/* ---------- view router ---------- */
function showView(name) {
  for (const v of ['dashboard', 'category', 'detail']) {
    $(`#view-${v}`).classList.toggle('hidden', v !== name);
  }
  renderCrumb(name);
  if (name === 'detail') $('#view-detail').scrollTop = 0;
  // if the execution shell was open, keep it alive across re-renders (but restore any maximize state)
  if (name !== 'detail') { setShellMax(false); $('#output-panel').classList.remove('open'); }
}

function renderCrumb(name) {
  const crumb = $('#view-crumb');
  crumb.innerHTML = '';
  const sep = () => {
    const s = document.createElement('span');
    s.className = 'crumb-sep';
    s.textContent = '/';
    return s;
  };
  if (name === 'dashboard') {
    const here = document.createElement('span');
    here.className = 'crumb-here';
    here.textContent = 'DASHBOARD';
    crumb.appendChild(here);
  } else {
    const home = document.createElement('span');
    home.className = 'crumb-link';
    home.textContent = 'DASHBOARD';
    home.onclick = () => openDashboard();
    crumb.appendChild(home);
    crumb.appendChild(sep());
    if (name === 'category') {
      const here = document.createElement('span');
      here.className = 'crumb-here';
      here.textContent = currentCategory === 'none' ? 'UNCATEGORIZED' : (catName(currentCategory) || 'CATEGORY').toUpperCase();
      crumb.appendChild(here);
    } else {
      const catLink = document.createElement('span');
      catLink.className = 'crumb-link';
      catLink.textContent = currentCategory === 'none' ? 'UNCATEGORIZED' : (catName(currentCategory) || 'CATEGORY').toUpperCase();
      catLink.onclick = () => openCategory(currentCategory);
      crumb.appendChild(catLink);
      crumb.appendChild(sep());
      const here = document.createElement('span');
      here.className = 'crumb-here';
      here.textContent = (currentProject ? currentProject.name : 'TOOL').toUpperCase();
      crumb.appendChild(here);
    }
  }
}
/* ---------- data ---------- */
async function loadCategories() {
  categories = await api('/categories');
  $('#pf-category').innerHTML =
    '<option value="">— none —</option>' +
    categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('') +
    '<option value="__new__">➕ New category…</option>';
}

async function loadProjects(q = '') {
  searchQuery = q;
  projects = await api(`/projects${q ? `?q=${encodeURIComponent(q)}` : ''}`);
}

/* ---------- dashboard (category roundels) ---------- */
async function openDashboard() {
  searchQuery = '';
  $('#search').value = '';
  currentCategory = null;
  currentProject = null;
  showView('dashboard');
  await refreshDashboard();
}

async function refreshDashboard() {
  const [_, all] = await Promise.all([loadCategories(), loadProjects()]);
  const grid = $('#cat-grid');
  grid.innerHTML = '';
  const counts = {}; // category_id -> project count
  let uncategorized = 0;
  for (const p of projects) {
    if (p.category_id == null) uncategorized++;
    else counts[p.category_id] = (counts[p.category_id] || 0) + 1;
  }
  $('#dash-sub').innerHTML = `<b>${projects.length}</b> tools registered · <b>${categories.length}</b> categories · vault link: <b>active</b>`;

  for (const c of categories) {
    grid.appendChild(roundel(c.name, counts[c.id] || 0, c.id));
  }
  if (uncategorized > 0) grid.appendChild(roundel('Uncategorized', uncategorized, 'none'));
  if (categories.length || uncategorized) {
    const add = roundel('New category', '', 'new');
    add.querySelector('.cat-core').style.border = '1px dashed rgba(34,211,238,.4)';
    add.querySelector('.cat-core').style.background = 'none';
    add.querySelector('.cat-core .c-initial').textContent = '＋';
    add.querySelector('.cat-core .c-initial').style.fontSize = '24px';
    grid.appendChild(add);
  }
  $('#dash-empty').hidden = Boolean(categories.length || uncategorized);
}

function roundel(name, count, catId) {
  const btn = document.createElement('button');
  btn.className = 'cat-roundel';
  const initials = (name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  btn.innerHTML = `
    <span class="cat-core">
      <span class="c-initial">${escapeHtml(initials)}</span>
      ${count !== '' ? `<span class="c-count">${count} tool${count === 1 ? '' : 's'}</span>` : ''}
    </span>
    <span class="cat-name">${escapeHtml(name)}</span>
    <span class="cat-count-out">${catId === 'new' ? '＋ create' : ''}</span>`;
  btn.onclick = () => {
    if (catId === 'new') return promptNewCategory();
    openCategory(catId);
  };
  return btn;
}

async function promptNewCategory() {
  const name = prompt('New category name:');
  if (!name || !name.trim()) return;
  try {
    const c = await api('/categories', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    toast(`Category "${c.name}" created`);
    await refreshDashboard();
  } catch (err) {
    toast(err.message);
  }
}

/* ---------- category view (carded tools) ---------- */
async function openCategory(catId) {
  searchQuery = '';
  $('#search').value = '';
  currentCategory = catId;
  currentProject = null;
  showView('category');
  try {
    await refreshCategory();
  } catch (e) {
    // slow network / aborted fetch — say so instead of leaving a dead empty view
    $('#catv-title').textContent = catName(catId) || 'CATEGORY';
    $('#catv-sub').textContent = 'load failed — click the sector again to retry';
    $('#tool-grid').innerHTML = '';
    toast(`Couldn't load tools: ${e.message}`);
  }
}

async function refreshCategory() {
  await loadProjects();
  const title = currentCategory === 'none' ? 'UNCATEGORIZED' : catName(currentCategory) || 'CATEGORY';
  const list = currentCategory === 'none' ? projects.filter((p) => p.category_id == null) : projects.filter((p) => String(p.category_id) === String(currentCategory));
  $('#catv-title').textContent = title;
  $('#catv-sub').innerHTML = `<b>${list.length}</b> tool${list.length === 1 ? '' : 's'} deployed`;

  const grid = $('#tool-grid');
  grid.innerHTML = '';
  if (!list.length) {
    const em = document.createElement('div');
    em.className = 'empty-cat';
    em.innerHTML = 'NO TOOLS IN THIS SECTOR<br><br>';
    em.appendChild(mkButton('＋ Register first tool', 'primary', () => openProjectDialog(null, currentCategory)));
    grid.appendChild(em);
    return;
  }
  list.forEach((p, i) => grid.appendChild(toolCard(p, i)));
  grid.appendChild(addToolCard());
}

function toolCard(p, i) {
  const card = document.createElement('article');
  card.className = 'holo-card';
  card.style.animationDelay = `${i * 0.05}s`;
  const glyph = (p.name || '?').trim().slice(0, 2).toUpperCase();
  const chips = (p.tags || []).slice(0, 4).map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join('');
  const desc = escapeHtml(p.purpose || p.description || 'No description on file.');
  const cat = p.category || catName(p.category_id) || 'uncategorized';
  card.innerHTML = `
    <div class="holo-top">
      <span class="holo-glyph">${escapeHtml(glyph)}</span>
      <span class="holo-name">${escapeHtml(p.name)}</span>
    </div>
    <div class="holo-desc">${desc}</div>
    <div class="holo-chips">${chips}</div>
    <div class="holo-meta"><span class="holo-cat">${escapeHtml(cat)}</span><span class="holo-status">access ▸</span></div>`;
  card.onclick = () => selectProject(p.id);
  return card;
}

function addToolCard() {
  const card = document.createElement('article');
  card.className = 'holo-card';
  card.style.border = '1px dashed rgba(34,211,238,.35)';
  card.style.background = 'transparent';
  card.style.display = 'grid';
  card.style.placeItems = 'center';
  card.style.minHeight = '150px';
  card.innerHTML = '<div style="text-align:center"><div style="font:700 26px var(--font-mono);color:var(--cyan-dim)">＋</div><div class="holo-status" style="margin-top:6px">register tool</div></div>';
  card.onclick = () => openProjectDialog(null, currentCategory);
  return card;
}
/* ---------- project detail ---------- */
async function selectProject(id) {
  currentProject = await api(`/projects/${id}`);
  showView('detail');
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
    if (!confirm(`Delete tool "${p.name}" and all its recipes and runs?`)) return;
    await api(`/projects/${p.id}`, { method: 'DELETE' });
    toast(`Tool "${p.name}" deleted`);
    currentProject = null;
    openCategory(currentCategory ?? null);
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
  h3.appendChild(document.createTextNode('Run recipes'));
  h3.appendChild(mkButton('＋ Add recipe', 'primary', () => openRecipeDialog()));
  sec.appendChild(h3);

  if (!p.recipes || !p.recipes.length) {
    const em = document.createElement('div');
    em.className = 'empty';
    em.style.border = '1px dashed var(--line-strong)';
    em.style.borderRadius = '8px';
    em.style.padding = '18px';
    em.style.color = 'var(--text-lo)';
    em.style.font = '500 11px var(--font-mono)';
    em.style.textAlign = 'center';
    em.textContent = 'No recipes yet — save how you run this tool.';
    sec.appendChild(em);
  }
  for (const r of p.recipes || []) renderRecipe(sec, r, byRecipe[r.id] || []);
  el.appendChild(sec);

  // keep a previously-open shell visible after re-render
  if (lastOutputRun && $('#output-panel').classList.contains('open')) {
    $('#output-panel').classList.add('open');
  }
}
/* ---------- search (cross-sector results, rendered as tool cards) ---------- */
async function runSearch(q) {
  searchMode = true;
  searchQuery = q;
  await loadProjects(q);
  showView('category');
  $('#catv-title').textContent = 'SEARCH RESULTS';
  $('#catv-sub').innerHTML = `query: "<b>${escapeHtml(q)}</b>" · <b>${projects.length}</b> match${projects.length === 1 ? '' : 'es'}`;
  renderCrumb('category');

  const grid = $('#tool-grid');
  grid.innerHTML = '';
  if (!projects.length) {
    grid.innerHTML = '<div class="empty-cat">NO MATCHING TOOLS IN THE VAULT</div>';
    return;
  }
  projects.forEach((p, i) => grid.appendChild(toolCard(p, i)));
}

function clearSearch() {
  if (!searchMode) return;
  searchMode = false;
  searchQuery = '';
  // hand the view back to whatever sector we came from (refresh callers re-render)
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

  const runBtn = mkButton('▶ Run', 'primary', () => runRecipe(r));
  const editBtn = mkButton('Edit', 'ghost', () => openRecipeDialog(r));
  const delBtn = mkButton('✕', 'danger', async () => {
    if (!confirm(`Delete recipe "${r.title}"?`)) return;
    await api(`/recipes/${r.id}`, { method: 'DELETE' });
    selectProject(currentProject.id);
  }, 'Delete recipe');
  top.append(runBtn, editBtn, delBtn);
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
    const run = runs[0];
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
/* ---------- run + execution shell ---------- */
// one flow for input: when Run is clicked, open the inline dialog pre-filled with
// the recipe's stdin default; on submit the answer is sent with the run request
// only — it is never written back to the database (it changes on every run).
let runningRecipeId = null;
function runRecipe(r) {
  runningRecipeId = r.id;
  const asArgs = !!r.input_as_args;
  $('#run-input-title').textContent = `Run "${r.title}"`;
  $('#ri-label').textContent = asArgs
    ? `Argument(s) for "${r.title}" — one value per line`
    : `Input for "${r.title}" — one answer per line`;
  $('#ri-value').value = r.stdin || '';
  $('#run-input-dialog').showModal();
}

$('#run-input-cancel').onclick = () => {
  runningRecipeId = null;
  $('#run-input-dialog').close();
};

$('#run-input-form').onsubmit = async (e) => {
  e.preventDefault();
  const r = (currentProject.recipes || []).find((x) => x.id === runningRecipeId);
  const answer = $('#ri-value').value.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  $('#run-input-dialog').close();
  runningRecipeId = null;
  if (!r) return;
  const btn = [...document.querySelectorAll('.r-top .primary')].find((b) => /run/i.test(b.textContent));
  if (btn) btn.disabled = true;
  try {
    // input travels with the run request only — nothing is persisted
    const res = await api(`/recipes/${r.id}/run`, { method: 'POST', body: JSON.stringify({ input: answer }), timeout: 180000 });
    openOutput(res.run_id, r.title, { max: true }); // auto-maximize the shell as soon as Run fires
  } catch (e) {
    toast(`Run failed: ${e.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
};

function openOutput(runId, title, opts = {}) {
  currentRunId = runId;
  lastOutputRun = { id: runId, title };
  $('#output-title').textContent = title ? `▸ ${title}` : `▸ run #${runId}`;
  $('#output').innerHTML = '<span class="cursor"></span>';
  $('#exit-code').textContent = '';
  setStatus('running');
  setShellMax(!!opts.max); // fresh runs auto-maximize; opening from history stays restored
  showView('detail'); // the shell lives in the detail view
  $('#output-panel').classList.add('open');
  $('#output-panel').scrollIntoView({ behavior: 'smooth', block: 'end' });
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
    out.textContent = run.output || '';
    if (run.status === 'running') {
      const cur = document.createElement('span');
      cur.className = 'cursor';
      out.appendChild(cur);
    }
    out.scrollTop = out.scrollHeight;
    setStatus(run.status);
    $('#exit-code').textContent = run.exit_code !== null && run.exit_code !== undefined ? `exit ${run.exit_code}` : '';
    if (run.status === 'running') {
      pollTimer = setTimeout(poll, 1000);
    } else if (currentProject && !$('#view-detail').classList.contains('hidden')) {
      renderDetail(); // refresh ribbons + last-run rows
    }
  } catch (e) {
    setStatus('failed');
    $('#output').textContent = `Error polling run: ${e.message}`;
  }
}

/* maximize / restore the execution shell */
function setShellMax(max) {
  $('#output-panel').classList.toggle('max', max);
  const b = $('#max-btn');
  b.textContent = max ? '⤡ restore' : '⤢ maximize';
  b.title = max ? 'Restore shell size' : 'Maximize shell';
  document.body.classList.toggle('exec-max', max);
  if (max) $('#output').scrollTop = $('#output').scrollHeight; // keep latest output in view after resize
}
$('#max-btn').onclick = () => setShellMax(!$('#output-panel').classList.contains('max'));
// Escape restores a maximized shell (open dialogs keep priority)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !$('#output-panel').classList.contains('max')) return;
  if ($('#project-dialog').open || $('#recipe-dialog').open) return;
  setShellMax(false);
});

$('#kill-btn').onclick = async () => {
  if (!currentRunId) return;
  try { await api(`/runs/${currentRunId}/kill`, { method: 'POST' }); } catch (_) { /* already done */ }
  poll();
};
$('#close-output').onclick = () => {
  setShellMax(false); // closing always restores size for the next run
  $('#output-panel').classList.remove('open');
  lastOutputRun = null;
  clearTimeout(pollTimer);
  // keep polling? no — run continues server-side, shell just closed
  currentRunId = null;
  if (currentProject && !$('#view-detail').classList.contains('hidden')) renderDetail();
};
/* ---------- project dialog ---------- */
function openProjectDialog(p = null, presetCat = null) {
  editingProjectId = p ? p.id : null;
  $('#project-dlg-title').textContent = p ? 'Edit tool' : 'New tool';
  const f = $('#project-form');
  f.reset();
  f.name.value = p ? p.name : '';
  f.repo_url.value = p ? p.repo_url : '';
  f.purpose.value = p ? p.purpose : '';
  f.category_id.value = p && p.category_id ? String(p.category_id) : (presetCat && presetCat !== 'none' ? String(presetCat) : '');
  f.tags.value = p ? (p.tags || []).join(', ') : '';
  $('#project-dialog').showModal();
}

$('#brand-home').onclick = () => openDashboard();
$('#new-project-btn').onclick = () => openProjectDialog();
$('#new-project-cat').onclick = () => openProjectDialog(null, currentCategory);
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
      await loadProjects(searchQuery);
      selectProject(editingProjectId);
    } else {
      const created = await api('/projects', { method: 'POST', body: JSON.stringify(body) });
      $('#project-dialog').close();
      // land on the category view that holds the new tool
      currentCategory = created.category_id ?? 'none';
      $('#search').value = '';
      searchQuery = '';
      showView('category');
      await refreshCategory();
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
  f.stdin.value = r ? r.stdin || '' : '';
  f.setup.value = r ? r.setup || '' : '';
  f.working_dir.value = r ? r.working_dir || '' : '';
  f.env.value = r ? r.env || '' : '';
  f.use_venv.checked = r ? !!r.use_venv : false;
  f.input_as_args.checked = r ? !!r.input_as_args : false;
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
    stdin: f.stdin.value.replace(/\r\n/g, '\n').replace(/\n+$/, ''),
    setup: f.setup.value.trim(),
    working_dir: f.working_dir.value.trim(),
    env: f.env.value,
    use_venv: f.use_venv.checked ? 1 : 0,
    input_as_args: f.input_as_args.checked ? 1 : 0,
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
  const q = e.target.value.trim();
  searchTimer = setTimeout(() => {
    if (q) {
      runSearch(q);
    } else {
      clearSearch();
      if (currentCategory === null) {
        showView('dashboard');
        refreshDashboard();
      } else {
        refreshCategory();
      }
    }
  }, 250);
});
// Escape clears the query and returns to the current sector
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.target.value = '';
    clearSearch();
    if (currentCategory === null) {
      showView('dashboard');
      refreshDashboard();
    } else {
      refreshCategory();
    }
  }
});

/* ---------- init ---------- */
(async () => {
  const boot = async () => {
    await loadCategories();
    await refreshDashboard();
  };
  // Supabase free tier can cold-start on the first query; retry with backoff
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await boot();
      return;
    } catch (err) {
      if (attempt === 6) {
        $('#dash-sub').textContent = 'vault link failed — is the server running?';
        toast(err.message);
        return;
      }
      $('#dash-sub').innerHTML = `linking vault… <i>attempt ${attempt}/6 · ${escapeHtml(err.message || String(err))}</i>`;
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
})();






