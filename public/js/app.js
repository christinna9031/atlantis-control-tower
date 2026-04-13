const socket = io();
let projects = [];
let hasPty = false;
let showHidden = false;

// ── Terminal clipboard support ───────────────────────
function enableTermClipboard(xterm, termId) {
  xterm.attachCustomKeyEventHandler(e => {
    // Ctrl+V / Cmd+V → paste
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
      if (e.type === 'keydown') {
        e.preventDefault();
        navigator.clipboard.readText().then(text => {
          if (text) socket.emit('terminal:input', { termId, data: text });
        }).catch(() => {});
      }
      return false;
    }
    // Ctrl+C / Cmd+C with selection → copy
    if ((e.ctrlKey || e.metaKey) && e.key === 'c' && xterm.hasSelection()) {
      if (e.type === 'keydown') {
        e.preventDefault();
        navigator.clipboard.writeText(xterm.getSelection());
      }
      return false;
    }
    // Backspace / Delete with selection → clear input line
    if ((e.key === 'Backspace' || e.key === 'Delete') && xterm.hasSelection()) {
      if (e.type === 'keydown') {
        // Ctrl+A (go to start) + Ctrl+K (kill to end) clears the whole line
        socket.emit('terminal:input', { termId, data: '\x01\x0b' });
        xterm.clearSelection();
      }
      return false;
    }
    return true;
  });
}

// ── API ─────────────────────────────────────────────
const api = {
  async get(url) { return (await fetch(url)).json(); },
  async post(url) {
    const res = await fetch(url, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) toast(data.error || 'Request failed', 'error');
    return data;
  },
  loadProjects: async () => { projects = await api.get('/api/projects'); render(); },
  start: id => api.post(`/api/projects/${id}/start`),
  stop: id => api.post(`/api/projects/${id}/stop`),
  restart: id => api.post(`/api/projects/${id}/restart`),
  restartAll: () => api.post('/api/projects/restart-all'),
  stopAll: () => api.post('/api/projects/stop-all'),
  toggleAutoStart: id => api.post(`/api/projects/${id}/toggle-autostart`),
  toggleHidden: id => api.post(`/api/projects/${id}/toggle-hidden`),
  openBrowser: id => api.post(`/api/projects/${id}/open`),
  openProduction: id => api.post(`/api/projects/${id}/open-production`),
  openFolder: id => api.post(`/api/projects/${id}/open-folder`),
  openGithub: id => api.post(`/api/projects/${id}/open-github`),
  getLogs: id => api.get(`/api/projects/${id}/logs`),
  async postJson(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) toast(data.error || 'Request failed', 'error');
    return data;
  },
  async putJson(url, body) {
    const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) toast(data.error || 'Request failed', 'error');
    return data;
  },
  async del(url) {
    const res = await fetch(url, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) toast(data.error || 'Request failed', 'error');
    return data;
  },
  addProject: body => api.postJson('/api/projects', body),
  createProject: body => api.postJson('/api/projects/create', body),
  updateProject: (id, body) => api.putJson(`/api/projects/${id}`, body),
  removeProject: id => api.del(`/api/projects/${id}`),
};

// ── Render Cards ────────────────────────────────────
function render() {
  const grid = document.getElementById('projects');
  const visible = projects.filter(p => showHidden || !p.hidden);
  const hiddenCount = projects.filter(p => p.hidden).length;
  const running = projects.filter(p => p.status === 'running').length;
  const el = document.getElementById('summary');
  el.textContent = `${running}/${projects.length} running`;
  el.style.color = running === projects.length ? '#22c55e' : running > 0 ? '#f59e0b' : '';

  grid.innerHTML = visible.map(p => {
    const canStart = p.status === 'stopped' || p.status === 'error';
    const canStop = p.status === 'running' || p.status === 'error';
    return `
    <div class="card ${p.status}${p.hidden ? ' is-hidden' : ''}" data-id="${p.id}" draggable="true"
         ondragstart="dragCard(event)" ondragover="dragOverCard(event)" ondragend="dropCard(event)">>
      <div class="card-header">
        <div class="card-icon">${p.iconPath ? `<img src="${p.iconPath}" alt="">` : p.icon}</div>
        <div class="card-info">
          <div class="card-name">${esc(p.name)}</div>
          <div class="card-meta">
            <span class="status-dot ${p.status}"></span>
            <span class="status-label">${p.status}${p.external ? ' (ext)' : ''}</span>
            <span class="card-memory">${p.memory ? ' · ' + formatMemory(p.memory) : ''}</span>
            <span class="card-port">:${p.port}</span>
          </div>
        </div>
        ${canStart
          ? `<button class="btn btn-sm btn-success card-power" onclick="api.start('${p.id}')">▶ Start</button>`
          : canStop
            ? `<button class="btn btn-sm btn-danger card-power" onclick="api.stop('${p.id}')">■ Stop</button>`
            : `<button class="btn btn-sm card-power" disabled>${p.status}…</button>`}
      </div>
      <div class="card-body">
        <div class="card-desc">${esc(p.description)}</div>
        <div class="card-path-row">
          <span class="card-path" title="${esc(p.path)}">${esc(p.path)}</span>
          <span class="card-path-actions">
            <span class="path-icon" onclick="api.openFolder('${p.id}')" title="Open folder">📂</span>
            ${p.githubUrl ? `<span class="path-icon" onclick="api.openGithub('${p.id}')" title="Open on GitHub"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg></span>` : ''}
          </span>
        </div>
      </div>
      <div class="card-actions">
        <button class="btn btn-icon btn-sm" onclick="api.restart('${p.id}')" title="Restart">🔄</button>
        <button class="btn btn-icon btn-sm btn-accent" onclick="api.openBrowser('${p.id}')" title="Open in Chrome">🌐</button>
        ${p.productionUrl ? `<button class="btn btn-icon btn-sm" onclick="api.openProduction('${p.id}')" title="Open Production" style="color:#a855f7">🚀</button>` : ''}
        <button class="btn btn-icon btn-sm" onclick="panel.openLogs('${p.id}')" title="Logs">📋</button>
        <button class="btn btn-icon btn-sm" onclick="openCopilot('${p.id}')" title="Ask Copilot" style="color:#22c55e">🤖</button>
        <button class="btn btn-icon btn-sm" onclick="openEditProject('${p.id}')" title="Settings">⚙️</button>
        <span class="autostart-badge ${p.autoStart ? '' : 'off'}"
              onclick="toggleAutoStart('${p.id}')"
              title="Toggle auto-start">
          ${p.autoStart ? '⚡ Auto' : '○ Manual'}
        </span>
      </div>
    </div>`;
  }).join('');

  // Combined actions card
  grid.innerHTML += `
    <div class="card add-card actions-card">
      <div class="actions-card-inner">
        <button class="actions-card-btn" onclick="openAddProject()">
          <span class="add-icon">＋</span>
          <span class="add-label">Add Project</span>
        </button>
        <button class="actions-card-btn create" onclick="openCreateProject()">
          <span class="add-icon">🚀</span>
          <span class="add-label">Create New</span>
        </button>
        ${hiddenCount > 0 ? `<button class="actions-card-btn" onclick="toggleShowHidden()">
          <span class="add-icon" style="font-size:1.2rem">${showHidden ? '👁️' : '👁️‍🗨️'}</span>
          <span class="add-label">${showHidden ? 'Hide' : 'Show'} ${hiddenCount} hidden</span>
        </button>` : ''}
      </div>
    </div>`;
}

// ── Drag-to-reorder ─────────────────────────────────
let _dragId = null;
function dragCard(e) {
  const card = e.target.closest('.card[data-id]');
  if (!card) return;
  _dragId = card.dataset.id;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}
function dragOverCard(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const target = e.target.closest('.card[data-id]');
  if (!target || target.dataset.id === _dragId) return;
  const grid = document.getElementById('projects');
  const dragging = grid.querySelector(`.card[data-id="${_dragId}"]`);
  if (!dragging) return;
  const cards = [...grid.querySelectorAll('.card[data-id]')];
  const fromIdx = cards.indexOf(dragging);
  const toIdx = cards.indexOf(target);
  if (fromIdx < toIdx) target.after(dragging);
  else target.before(dragging);
}
function dropCard(e) {
  const card = e.target.closest('.card[data-id]');
  if (card) card.classList.remove('dragging');
  document.querySelectorAll('.card.dragging').forEach(c => c.classList.remove('dragging'));
  if (!_dragId) return;
  _dragId = null;
  // Read new order from DOM and save
  const order = [...document.querySelectorAll('#projects .card[data-id]')].map(c => c.dataset.id);
  // Update local projects array to match
  const byId = new Map(projects.map(p => [p.id, p]));
  const reordered = order.filter(id => byId.has(id)).map(id => byId.get(id));
  for (const p of projects) { if (!order.includes(p.id)) reordered.push(p); }
  projects.length = 0;
  projects.push(...reordered);
  api.postJson('/api/projects/reorder', { order });
}

// ── Tabbed Panel ────────────────────────────────────
const panel = {
  tabs: [],
  activeId: null,
  termInstances: new Map(),
  logSubscriptions: new Set(),

  open() {
    document.getElementById('panel').classList.add('open');
    document.getElementById('panel-toggle').textContent = '▼';
    syncGridPadding();
    const active = this.tabs.find(t => t.id === this.activeId);
    if (active?.type === 'terminal') {
      setTimeout(() => this._fitTerminal(active.id), 350);
    }
  },

  close() {
    document.getElementById('panel').classList.remove('open');
    document.getElementById('panel-toggle').textContent = '▲';
    syncGridPadding();
  },

  toggle() {
    const el = document.getElementById('panel');
    if (el.classList.contains('open')) this.close();
    else this.open();
  },

  _renderTabs() {
    const container = document.getElementById('panel-tabs');
    container.innerHTML = this.tabs.map(t => `
      <div class="panel-tab ${t.id === this.activeId ? 'active' : ''}"
           onclick="panel.activate('${t.id}')">
        <span>${t.icon} ${t.label}</span>
        <span class="tab-close" onclick="event.stopPropagation(); panel.closeTab('${t.id}')">✕</span>
      </div>
    `).join('');
  },

  _renderBody() {
    const body = document.getElementById('panel-body');
    body.querySelectorAll('.panel-pane').forEach(el => el.classList.remove('active'));
    const pane = body.querySelector(`[data-tab-id="${this.activeId}"]`);
    if (pane) pane.classList.add('active');
  },

  activate(id) {
    this.activeId = id;
    this._renderTabs();
    this._renderBody();
    const tab = this.tabs.find(t => t.id === id);
    if (tab?.type === 'terminal') {
      setTimeout(() => {
        this._fitTerminal(id);
        const inst = this.termInstances.get(id);
        if (inst) inst.xterm.focus();
      }, 50);
    }
  },

  closeTab(id) {
    const tab = this.tabs.find(t => t.id === id);
    if (!tab) return;

    if (tab.type === 'terminal') {
      socket.emit('terminal:close', { termId: id });
      const inst = this.termInstances.get(id);
      if (inst) { inst.xterm.dispose(); this.termInstances.delete(id); }
    }
    if (tab.type === 'log') this.logSubscriptions.delete(tab.projectId);

    const pane = document.getElementById('panel-body').querySelector(`[data-tab-id="${id}"]`);
    if (pane) pane.remove();

    this.tabs = this.tabs.filter(t => t.id !== id);
    if (this.activeId === id) {
      this.activeId = this.tabs.length ? this.tabs[this.tabs.length - 1].id : null;
    }
    this._renderTabs();
    this._renderBody();
    if (!this.tabs.length) this.close();
  },

  // ── Logs ────────────────────────────────────────
  async openLogs(projectId) {
    const existing = this.tabs.find(t => t.type === 'log' && t.projectId === projectId);
    if (existing) { this.activate(existing.id); this.open(); return; }

    const p = projects.find(p => p.id === projectId);
    const id = `log-${projectId}`;
    this.tabs.push({ id, type: 'log', projectId, label: p?.name || projectId, icon: '📋' });
    this.logSubscriptions.add(projectId);

    const body = document.getElementById('panel-body');
    const pane = document.createElement('div');
    pane.className = 'panel-pane';
    pane.dataset.tabId = id;
    pane.innerHTML = `<div class="log-content" id="logc-${projectId}"></div>`;
    body.appendChild(pane);

    this.activate(id);
    this.open();

    const logs = await api.getLogs(projectId);
    const el = document.getElementById(`logc-${projectId}`);
    logs.forEach(entry => this._appendLog(el, entry));
  },

  _appendLog(el, { time, type, message }) {
    if (!el) return;
    const t = new Date(time).toLocaleTimeString();
    const div = document.createElement('div');
    div.className = `log-entry ${type}`;
    div.innerHTML = `<span class="log-time">${t}</span><span class="log-msg">${esc(message)}</span>`;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  },

  // ── Terminal ────────────────────────────────────
  openTerminal(projectId) {
    if (!hasPty) { toast('Terminal not available (node-pty missing)', 'error'); return; }

    const p = projects.find(p => p.id === projectId);
    const id = `term-${projectId}-${Date.now()}`;
    this.tabs.push({ id, type: 'terminal', projectId, label: p?.name || projectId, icon: '💻' });

    const body = document.getElementById('panel-body');
    const pane = document.createElement('div');
    pane.className = 'panel-pane';
    pane.dataset.tabId = id;
    pane.innerHTML = `<div class="terminal-container" id="tc-${id}"></div>`;
    body.appendChild(pane);

    this.activate(id);
    this.open();

    const xterm = new Terminal({
      theme: {
        background: '#060d19',
        foreground: '#e2e8f0',
        cursor: '#22d3ee',
        cursorAccent: '#060d19',
        selectionBackground: 'rgba(34,211,238,0.3)',
        black: '#0d1a2d', red: '#ef4444', green: '#22c55e', yellow: '#f59e0b',
        blue: '#22d3ee', magenta: '#a855f7', cyan: '#2dd4bf', white: '#e2e8f0',
        brightBlack: '#4a5e78', brightRed: '#f87171', brightGreen: '#4ade80',
        brightYellow: '#fbbf24', brightBlue: '#67e8f9', brightMagenta: '#c084fc',
        brightCyan: '#5eead4', brightWhite: '#f8fafc',
      },
      fontFamily: "'Geist Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon.FitAddon();
    xterm.loadAddon(fitAddon);
    try { xterm.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch {}

    const container = document.getElementById(`tc-${id}`);
    xterm.open(container);
    setTimeout(() => fitAddon.fit(), 50);

    this.termInstances.set(id, { xterm, fitAddon });

    socket.emit('terminal:create', { termId: id, projectId });
    xterm.onData(data => socket.emit('terminal:input', { termId: id, data }));
    xterm.onResize(({ cols, rows }) => socket.emit('terminal:resize', { termId: id, cols, rows }));
    enableTermClipboard(xterm, id);
    xterm.focus();
  },

  _fitTerminal(id) {
    const inst = this.termInstances.get(id);
    if (inst) { try { inst.fitAddon.fit(); } catch {} }
  },
};

// ── Socket Events ───────────────────────────────────
socket.on('pty:available', v => { hasPty = v; });

socket.on('project:status', ({ id, status, pid, external }) => {
  const p = projects.find(p => p.id === id);
  if (p) {
    const prev = p.status;
    p.status = status; p.pid = pid; p.external = external;
    render();
    if (prev !== status) {
      if (status === 'running') toast(`${p.name} is running`, 'success');
      else if (status === 'error') toast(`${p.name} errored`, 'error');
      else if (status === 'stopped' && prev !== 'stopped') toast(`${p.name} stopped`, 'info');
    }
  }
});

socket.on('project:log', ({ id, time, type, message }) => {
  if (!panel.logSubscriptions.has(id)) return;
  const el = document.getElementById(`logc-${id}`);
  if (el) panel._appendLog(el, { time, type, message });
});

socket.on('project:memory', ({ id, memory }) => {
  const p = projects.find(p => p.id === id);
  if (p) p.memory = memory;
  const el = document.querySelector(`.card[data-id="${id}"] .card-memory`);
  if (el) el.textContent = memory ? ' · ' + formatMemory(memory) : '';
});

socket.on('terminal:output', ({ termId, data }) => {
  const inst = panel.termInstances.get(termId);
  if (inst) inst.xterm.write(data);
});

socket.on('terminal:exit', ({ termId }) => {
  const inst = panel.termInstances.get(termId);
  if (inst) inst.xterm.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n');
});

// ── Sync grid padding with panel height ─────────────
function syncGridPadding() {
  const panelEl = document.getElementById('panel');
  const grid = document.querySelector('.grid');
  if (grid) grid.style.paddingBottom = (panelEl.offsetHeight + 16) + 'px';
}

// ── Resize ──────────────────────────────────────────
window.addEventListener('resize', () => {
  const active = panel.tabs.find(t => t.id === panel.activeId);
  if (active?.type === 'terminal') panel._fitTerminal(active.id);
  syncGridPadding();
});

// Re-fit terminal after panel CSS transition ends
document.getElementById('panel').addEventListener('transitionend', () => {
  const active = panel.tabs.find(t => t.id === panel.activeId);
  if (active?.type === 'terminal') panel._fitTerminal(active.id);
  syncGridPadding();
});

// Drag to resize panel
(function() {
  const panelEl = document.getElementById('panel');
  const bar = document.querySelector('.panel-bar');
  let dragging = false, startY, startH;
  bar.addEventListener('mousedown', e => {
    if (e.target.closest('.panel-tab, .panel-bar-actions, button')) return;
    dragging = true; startY = e.clientY; startH = panelEl.offsetHeight;
    panelEl.classList.add('resizing');
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const h = Math.max(42, Math.min(window.innerHeight - 60, startH + (startY - e.clientY)));
    panelEl.style.height = h + 'px';
    syncGridPadding();
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    panelEl.classList.remove('resizing');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const active = panel.tabs.find(t => t.id === panel.activeId);
    if (active?.type === 'terminal') panel._fitTerminal(active.id);
    syncGridPadding();
  });
})();

// ── Auto-start toggle ───────────────────────────────
async function toggleAutoStart(id) {
  const res = await api.toggleAutoStart(id);
  const p = projects.find(p => p.id === id);
  if (p && res.autoStart !== undefined) p.autoStart = res.autoStart;
  render();
}

async function toggleHidden(id) {
  const res = await api.toggleHidden(id);
  const p = projects.find(p => p.id === id);
  if (p && res.hidden !== undefined) p.hidden = res.hidden;
  closeModal();
  render();
  toast(res.hidden ? 'Project hidden' : 'Project visible', 'info');
}

function toggleShowHidden() {
  showHidden = !showHidden;
  render();
}

// ── Project Modal (Add / Edit) ──────────────────────
const ICON_EMOJIS = [
  '📦','🌐','🐠','🏠','🎮','📷','🎬','🔧','📊','🛒',
  '💬','📡','🤖','⚡','🔥','🎵','📱','💻','🖥️','🗄️',
  '🎨','📝','🔒','🌍','🚀','📈','🧪','🎯','🛠️','📸',
  '🐍','🐳','🦈','🐙','🦀','🪸','🐟','🐡','🦑','🐢',
  '🏡','🏘️','🏗️','🏢','🗺️','📍','🔎','📺','🎥','🎛️',
];

function projectModalHtml(p) {
  const isEdit = !!p;
  const title = isEdit ? `Edit ${p.name}` : 'Add New Project';
  const submitLabel = isEdit ? 'Save Changes' : 'Add Project';
  const currentIcon = p?.icon || '📦';
  const hasCustomIcon = !!p?.iconPath;
  return `
    <div class="modal-backdrop" onclick="closeModal()"></div>
    <div class="modal">
      <div class="modal-header">
        <h3>${title}</h3>
        <button class="btn btn-icon" onclick="closeModal()">✕</button>
      </div>
      <form onsubmit="handleProjectSubmit(event, ${isEdit ? `'${p.id}'` : 'null'})">
        <input type="hidden" name="icon" value="${esc(currentIcon)}" />
        <input type="hidden" name="iconPath" value="${esc(p?.iconPath || '')}" />
        <div class="modal-body">
          <div class="form-row">
            <label>Name</label>
            <input name="name" value="${esc(p?.name || '')}" placeholder="My Project" required />
          </div>
          <div class="form-row">
            <label>Icon</label>
            <div class="icon-picker">
              <div class="icon-preview" id="icon-preview">
                ${hasCustomIcon ? `<img src="${p.iconPath}" alt="icon">` : `<span>${currentIcon}</span>`}
              </div>
              <div class="icon-picker-options">
                <div class="icon-search-row">
                  <input type="text" id="icon-search-input" class="icon-search-input" placeholder="Search icons online…"
                         onkeydown="if(event.key==='Enter'){event.preventDefault();searchIcons()}" />
                  <button type="button" class="btn btn-sm btn-accent" onclick="searchIcons()">🔍</button>
                </div>
                <div class="icon-search-results" id="icon-search-results" style="display:none"></div>
                <div class="icon-grid" id="icon-grid">
                  ${ICON_EMOJIS.map(e => `<span class="icon-option ${e === currentIcon && !hasCustomIcon ? 'active' : ''}" onclick="pickEmoji(this, '${e}')">${e}</span>`).join('')}
                </div>
                <div class="icon-upload-row">
                  <label class="btn btn-sm btn-ghost icon-upload-btn">
                    📁 Upload Image
                    <input type="file" accept="image/*" onchange="previewIconUpload(this)" style="display:none" />
                  </label>
                  ${hasCustomIcon ? `<button type="button" class="btn btn-sm btn-ghost" onclick="clearCustomIcon()" style="color:var(--danger)">✕ Remove</button>` : ''}
                </div>
              </div>
            </div>
          </div>
          <div class="form-row">
            <label>Project Path</label>
            <input name="path" value="${esc(p?.path || '')}" placeholder="K:\\my-project" required />
          </div>
          <div style="display:flex;gap:12px">
            <div class="form-row" style="flex:1">
              <label>Start Command</label>
              <input name="startCommand" value="${esc(p?.startCommand || 'npm start')}" placeholder="npm start" />
            </div>
            <div class="form-row" style="width:120px">
              <label>Port</label>
              <input name="port" type="number" value="${p?.port || 3000}" min="1" max="65535" />
            </div>
          </div>
          <div class="form-row">
            <label>Description</label>
            <input name="description" value="${esc(p?.description || '')}" placeholder="What does this project do?" />
          </div>
          <div class="form-row">
            <label>Production URL</label>
            <input name="productionUrl" value="${esc(p?.productionUrl || '')}" placeholder="https://myapp.vercel.app (optional)" />
          </div>
          <div class="form-row">
            <label>GitHub URL</label>
            <input name="githubUrl" value="${esc(p?.githubUrl || '')}" placeholder="https://github.com/user/repo (optional)" />
          </div>
        </div>
        <div class="modal-footer">
          ${isEdit ? `<div class="modal-footer-left">
            <button type="button" class="btn btn-sm btn-ghost" onclick="toggleHidden('${p.id}')">${p.hidden ? '👁️ Unhide' : '👁️‍🗨️ Hide'}</button>
            <button type="button" class="btn btn-sm btn-danger" onclick="removeProject('${p.id}')">🗑 Remove</button>
          </div>` : '<span></span>'}
          <div>
            <button type="button" class="btn btn-sm" onclick="closeModal()">Cancel</button>
            <button type="submit" class="btn btn-sm btn-success">${submitLabel}</button>
          </div>
        </div>
      </form>
    </div>`;
}

let _pendingIconFile = null;

function pickEmoji(el, emoji) {
  _pendingIconFile = null;
  document.querySelectorAll('.icon-option').forEach(e => e.classList.remove('active'));
  el.classList.add('active');
  document.querySelector('input[name="icon"]').value = emoji;
  document.querySelector('input[name="iconPath"]').value = '';
  document.getElementById('icon-preview').innerHTML = `<span>${emoji}</span>`;
}

function previewIconUpload(input) {
  const file = input.files[0];
  if (!file) return;
  _pendingIconFile = file;
  document.querySelectorAll('.icon-option').forEach(e => e.classList.remove('active'));
  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById('icon-preview').innerHTML = `<img src="${e.target.result}" alt="icon">`;
    document.querySelector('input[name="icon"]').value = '';
  };
  reader.readAsDataURL(file);
}

function clearCustomIcon() {
  _pendingIconFile = null;
  _pendingSearchIcon = null;
  const fallback = document.querySelector('input[name="icon"]').value || '📦';
  document.querySelector('input[name="iconPath"]').value = '';
  document.getElementById('icon-preview').innerHTML = `<span>${fallback || '📦'}</span>`;
  if (!fallback) document.querySelector('input[name="icon"]').value = '📦';
}

let _pendingSearchIcon = null;

async function searchIcons() {
  const input = document.getElementById('icon-search-input');
  const q = input.value.trim();
  if (!q) return;
  const resultsEl = document.getElementById('icon-search-results');
  resultsEl.style.display = '';
  resultsEl.innerHTML = '<div class="icon-search-loading">Searching…</div>';
  try {
    const data = await api.get(`/api/icons/search?q=${encodeURIComponent(q)}`);
    if (!data.icons?.length) {
      resultsEl.innerHTML = '<div class="icon-search-loading">No icons found</div>';
      return;
    }
    resultsEl.innerHTML = data.icons.map(ic =>
      `<div class="icon-search-item" onclick="pickSearchIcon(this, '${esc(ic.svgUrl)}', '${esc(ic.name)}')" title="${esc(ic.name)}">
        <img src="${esc(ic.svgUrl)}" alt="${esc(ic.name)}" loading="lazy" />
      </div>`
    ).join('');
  } catch (e) {
    resultsEl.innerHTML = `<div class="icon-search-loading">Error: ${esc(e.message)}</div>`;
  }
}

function pickSearchIcon(el, svgUrl, iconName) {
  _pendingIconFile = null;
  _pendingSearchIcon = { svgUrl, iconName };
  document.querySelectorAll('.icon-option').forEach(e => e.classList.remove('active'));
  document.querySelectorAll('.icon-search-item').forEach(e => e.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('icon-preview').innerHTML = `<img src="${svgUrl}" alt="icon">`;
  document.querySelector('input[name="icon"]').value = '';
  document.querySelector('input[name="iconPath"]').value = '';
}

function openAddProject() {
  const container = document.getElementById('modal-container');
  container.innerHTML = projectModalHtml(null);
  container.style.display = 'flex';
}

function createProjectModalHtml() {
  return `
    <div class="modal-backdrop" onclick="closeModal()"></div>
    <div class="modal">
      <div class="modal-header">
        <h3>🚀 Create New Project</h3>
        <button class="btn btn-icon" onclick="closeModal()">✕</button>
      </div>
      <form onsubmit="handleCreateProject(event)">
        <div class="modal-body">
          <div class="form-row">
            <label>Project Name</label>
            <input name="name" placeholder="my-awesome-project" required autofocus />
          </div>
          <div class="form-row">
            <label>Folder Path</label>
            <input name="folder" placeholder="K:\\my-awesome-project" required />
            <small style="color:var(--text-muted);margin-top:4px;display:block">Folder will be created if it doesn't exist</small>
          </div>
        </div>
        <div class="modal-footer">
          <span></span>
          <div>
            <button type="button" class="btn btn-sm" onclick="closeModal()">Cancel</button>
            <button type="submit" class="btn btn-sm btn-success">Create & Open Copilot</button>
          </div>
        </div>
      </form>
    </div>`;
}

function openCreateProject() {
  const container = document.getElementById('modal-container');
  container.innerHTML = createProjectModalHtml();
  container.style.display = 'flex';
  // Auto-fill folder when name changes
  const nameInput = container.querySelector('input[name="name"]');
  const folderInput = container.querySelector('input[name="folder"]');
  let folderManuallyEdited = false;
  folderInput.addEventListener('input', () => { folderManuallyEdited = true; });
  nameInput.addEventListener('input', () => {
    if (!folderManuallyEdited) {
      folderInput.value = 'K:\\' + nameInput.value.trim().replace(/\s+/g, '-');
    }
  });
}

async function handleCreateProject(e) {
  e.preventDefault();
  const form = e.target;
  const name = form.name.value.trim();
  const folder = form.folder.value.trim();
  if (!name || !folder) return;

  const res = await api.createProject({ name, folder });
  if (res.error) return;

  toast(`${res.name} created!`, 'success');
  closeModal();
  await api.loadProjects();

  // Launch Copilot terminal for the new project
  if (hasPty) {
    _launchCopilotTerminal(res.id);
  }
}

function openEditProject(id) {
  const p = projects.find(p => p.id === id);
  if (!p) return;
  const container = document.getElementById('modal-container');
  container.innerHTML = projectModalHtml(p);
  container.style.display = 'flex';
}

function closeModal() {
  const container = document.getElementById('modal-container');
  container.style.display = 'none';
  container.innerHTML = '';
}

async function handleProjectSubmit(e, editId) {
  e.preventDefault();
  const form = e.target;
  const data = {
    name: form.name.value,
    icon: form.icon.value,
    path: form.path.value,
    startCommand: form.startCommand.value,
    port: parseInt(form.port.value),
    description: form.description.value,
    productionUrl: form.productionUrl.value || '',
    githubUrl: form.githubUrl.value || '',
  };

  let projectId = editId;
  if (editId) {
    const res = await api.updateProject(editId, data);
    if (res.id) toast(`${res.name} updated`, 'success');
  } else {
    const res = await api.addProject(data);
    if (res.id) { toast(`${res.name} added`, 'success'); projectId = res.id; }
  }

  // Handle icon: search icon download > file upload > emoji (already saved via data.icon)
  if (projectId && _pendingSearchIcon) {
    await api.postJson(`/api/projects/${projectId}/icon-download`, _pendingSearchIcon);
    _pendingSearchIcon = null;
  } else if (projectId && _pendingIconFile) {
    const fd = new FormData();
    fd.append('icon', _pendingIconFile);
    await fetch(`/api/projects/${projectId}/icon`, { method: 'POST', body: fd });
    _pendingIconFile = null;
  }

  closeModal();
  await api.loadProjects();
}

async function removeProject(id) {
  const p = projects.find(p => p.id === id);
  if (!confirm(`Remove "${p?.name}"? This won't delete the files.`)) return;
  const res = await api.removeProject(id);
  if (res.ok) toast(`${res.removed} removed`, 'info');
  closeModal();
  await api.loadProjects();
}

// ── Toast ───────────────────────────────────────────
function toast(msg, type = 'info') {
  const container = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3500);
}

// ── Helpers ─────────────────────────────────────────
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function formatMemory(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(0) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

// ── Navigation ──────────────────────────────────────
function switchView(view) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.getElementById('view-projects').style.display = view === 'projects' ? '' : 'none';
  document.getElementById('view-sessions').style.display = view === 'sessions' ? '' : 'none';
  document.getElementById('view-copilot').style.display = view === 'copilot' ? '' : 'none';
  if (view === 'sessions' && !sessions._loaded) sessions.load();
}

// ── Sessions ────────────────────────────────────────
const sessions = {
  _loaded: false,
  data: [],

  async load() {
    const rows = await api.get('/api/sessions');
    this.data = rows;
    this._loaded = true;
    this._renderList(rows);
    document.getElementById('session-detail').innerHTML = '';
    document.getElementById('session-detail').style.display = 'none';
    document.getElementById('sessions-list').style.display = '';
  },

  async search(q) {
    if (!q.trim()) return this.load();
    const results = await api.get(`/api/sessions/search?q=${encodeURIComponent(q)}`);
    // Group by session_id and fetch session summaries
    const sessionIds = [...new Set(results.map(r => r.session_id))];
    const allSessions = this.data.length ? this.data : await api.get('/api/sessions?limit=200');
    const matched = allSessions.filter(s => sessionIds.includes(s.id));
    if (!matched.length && results.length) {
      // Sessions not in local cache, just show IDs
      document.getElementById('sessions-list').innerHTML =
        `<div style="padding:20px;color:var(--text-muted)">Found ${results.length} matches across ${sessionIds.length} sessions. Showing snippets:</div>` +
        results.map(r => `<div class="session-row" onclick="sessions.openById('${r.session_id}')">
          <span class="session-summary">${esc(r.content?.substring(0, 120) || '...')}</span>
          <span class="session-cwd">${r.source_type}</span>
        </div>`).join('');
    } else {
      this._renderList(matched);
    }
    document.getElementById('session-detail').style.display = 'none';
    document.getElementById('sessions-list').style.display = '';
  },

  _renderList(rows) {
    const el = document.getElementById('sessions-list');
    if (!rows.length) {
      el.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">No sessions found</div>';
      return;
    }
    el.innerHTML = rows.map(s => {
      const d = new Date(s.created_at);
      const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      return `<div class="session-row">
        <span class="session-date">${date}<br>${time}</span>
        <span class="session-summary" onclick="sessions.openById('${s.id}')">${esc(s.summary || 'Untitled session')}</span>
        <span class="session-cwd">${esc(s.cwd || '')}</span>
        <button class="btn btn-sm btn-ghost session-resume-btn" onclick="event.stopPropagation();resumeSession('${s.id}')" title="Resume with Copilot">🤖</button>
      </div>`;
    }).join('');
  },

  async openById(id) {
    const data = await api.get(`/api/sessions/${id}`);
    if (!data.session) return toast('Session not found', 'error');
    this._renderDetail(data);
  },

  _renderDetail({ session, turns, files, checkpoints }) {
    document.getElementById('sessions-list').style.display = 'none';
    const el = document.getElementById('session-detail');
    el.style.display = '';

    const d = new Date(session.created_at);
    const dateStr = d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    let html = `
      <button class="detail-back" onclick="sessions.load()">← Back to sessions</button>
      <div class="detail-header">
        <div class="detail-header-top">
          <div>
            <h2>${esc(session.summary || 'Untitled session')}</h2>
            <div class="detail-meta">${dateStr} at ${timeStr} · ${esc(session.cwd || '')}</div>
          </div>
          <button class="btn btn-sm btn-success" onclick="resumeSession('${session.id}')" title="Resume this session with Copilot">🤖 Resume Session</button>
        </div>
      </div>`;

    if (files?.length) {
      html += `<div class="detail-section"><h3>Files Modified (${files.length})</h3>
        <div class="detail-files">${files.map(f =>
          `<span class="file-tag" title="${esc(f.file_path)}">${esc(f.file_path.split('\\').pop().split('/').pop())}</span>`
        ).join('')}</div></div>`;
    }

    if (checkpoints?.length) {
      html += `<div class="detail-section"><h3>Checkpoints</h3>
        <div class="conversation">${checkpoints.map(c => `
          <div class="turn assistant">
            <div class="turn-label">Checkpoint ${c.checkpoint_number}: ${esc(c.title || '')}</div>
            <div class="turn-content">${esc(c.overview || c.work_done || '')}</div>
          </div>`).join('')}</div></div>`;
    }

    if (turns?.length) {
      html += `<div class="detail-section"><h3>Conversation (${turns.length} turns)</h3>
        <div class="conversation">${turns.map(t => {
          let out = '';
          if (t.user_message) out += `<div class="turn user"><div class="turn-label">You</div><div class="turn-content">${esc(t.user_message)}</div></div>`;
          if (t.assistant_response) out += `<div class="turn assistant"><div class="turn-label">Copilot</div><div class="turn-content">${esc(t.assistant_response.substring(0, 2000))}${t.assistant_response.length > 2000 ? '…' : ''}</div></div>`;
          return out;
        }).join('')}</div></div>`;
    }

    el.innerHTML = html;
  },
};

// ── Copilot Launch ──────────────────────────────────
let copilotState = { projectId: null, activeSessionId: null };

async function openCopilot(projectId) {
  const p = projects.find(p => p.id === projectId);
  if (!p) return;
  if (!hasPty) { toast('Terminal not available', 'error'); return; }

  copilotState.projectId = projectId;

  // Check if there's already a copilot terminal for this project
  const existing = panel.tabs.find(t => t.type === 'terminal' && t.projectId === projectId && t.label.includes('🤖'));
  if (existing) {
    panel.activate(existing.id);
    panel.open();
  } else {
    _launchCopilotTerminal(projectId);
  }
}

function resumeSession(sessionId) {
  if (!hasPty) { toast('Terminal not available', 'error'); return; }

  const id = `session-${sessionId.substring(0, 8)}-${Date.now()}`;
  panel.tabs.push({ id, type: 'terminal', label: 'Resumed Session', icon: '🤖' });

  const body = document.getElementById('panel-body');
  const pane = document.createElement('div');
  pane.className = 'panel-pane';
  pane.dataset.tabId = id;
  pane.innerHTML = `<div class="terminal-container" id="tc-${id}"></div>`;
  body.appendChild(pane);

  panel.activate(id);
  panel.open();

  const xterm = new Terminal({
    theme: {
      background: '#060d19', foreground: '#e2e8f0', cursor: '#22d3ee', cursorAccent: '#060d19',
      selectionBackground: 'rgba(34,211,238,0.3)',
      black: '#0d1a2d', red: '#ef4444', green: '#22c55e', yellow: '#f59e0b',
      blue: '#22d3ee', magenta: '#a855f7', cyan: '#2dd4bf', white: '#e2e8f0',
      brightBlack: '#4a5e78', brightRed: '#f87171', brightGreen: '#4ade80',
      brightYellow: '#fbbf24', brightBlue: '#67e8f9', brightMagenta: '#c084fc',
      brightCyan: '#5eead4', brightWhite: '#f8fafc',
    },
    fontFamily: "'Geist Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace",
    fontSize: 13, lineHeight: 1.3, cursorBlink: true, allowProposedApi: true,
  });

  const fitAddon = new FitAddon.FitAddon();
  xterm.loadAddon(fitAddon);
  try { xterm.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch {}

  const container = document.getElementById(`tc-${id}`);
  xterm.open(container);
  setTimeout(() => fitAddon.fit(), 50);

  panel.termInstances.set(id, { xterm, fitAddon });

  socket.emit('terminal:create', { termId: id });

  // Block user input while session is restoring
  let inputBlocked = true;
  xterm.onData(data => {
    if (!inputBlocked) socket.emit('terminal:input', { termId: id, data });
  });
  xterm.onResize(({ cols, rows }) => socket.emit('terminal:resize', { termId: id, cols, rows }));
  enableTermClipboard(xterm, id);

  // Unblock input once Copilot is ready or shows an interactive prompt
  const unblockOnReady = ({ termId: tid, data: out }) => {
    if (tid !== id) return;
    if (out.includes('Describe a task') || out.includes('shift+tab') || out.includes('reqs.')
        || out.includes('Session storage') || out.includes('to navigate') || out.includes('to confirm')) {
      inputBlocked = false;
      socket.off('terminal:output', unblockOnReady);
    }
  };
  socket.on('terminal:output', unblockOnReady);
  setTimeout(() => { inputBlocked = false; socket.off('terminal:output', unblockOnReady); }, 60000);

  const cmd = `copilot --autopilot --resume=${sessionId}`;
  setTimeout(() => socket.emit('terminal:input', { termId: id, data: cmd + '\r' }), 1500);
  xterm.focus();
}

async function showProjectSessions(projectId) {
  const p = projects.find(p => p.id === projectId);
  if (!p) return;

  copilotState.projectId = projectId;
  switchView('copilot');
  document.getElementById('copilot-project-name').textContent = `${p.icon} ${p.name}`;
  document.getElementById('copilot-context').innerHTML = '<div class="copilot-empty">Loading session history…</div>';
  document.getElementById('copilot-session-list').innerHTML = '';

  try {
    const data = await api.get(`/api/sessions/for-project?projectId=${projectId}`);
    if (!data || !data.session) {
      document.getElementById('copilot-context').innerHTML = '<div class="copilot-empty">No previous sessions found for this project</div>';
      return;
    }

    const listEl = document.getElementById('copilot-session-list');
    const related = data.relatedSessions || [];
    listEl.innerHTML = related.map(s => {
      const d = new Date(s.created_at);
      const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return `<div class="copilot-session-item ${s.id === data.session.id ? 'active' : ''}"
                   onclick="loadCopilotSession('${s.id}')">
        <div class="cs-summary">${esc(s.summary || 'Untitled')}</div>
        <div class="cs-date">${dateStr}</div>
      </div>`;
    }).join('');

    copilotState.activeSessionId = data.session.id;
    renderCopilotContext(data);
  } catch (e) {
    document.getElementById('copilot-context').innerHTML = `<div class="copilot-empty">Error: ${esc(e.message)}</div>`;
  }
}

async function loadCopilotSession(sessionId) {
  copilotState.activeSessionId = sessionId;
  document.querySelectorAll('.copilot-session-item').forEach(el => el.classList.remove('active'));
  event?.target?.closest?.('.copilot-session-item')?.classList.add('active');

  document.getElementById('copilot-context').innerHTML = '<div class="copilot-empty">Loading…</div>';
  const data = await api.get(`/api/sessions/${sessionId}`);
  renderCopilotContext(data);
}

function renderCopilotContext(data) {
  const { session, turns, files, checkpoints } = data;
  const el = document.getElementById('copilot-context');
  const d = new Date(session.created_at);
  const dateStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  let html = `<div class="ctx-header">
    <h2>${esc(session.summary || 'Untitled session')}</h2>
    <div class="ctx-meta">${dateStr} at ${timeStr}</div>
  </div>`;

  if (files?.length) {
    html += `<div class="detail-section"><h3>Files (${files.length})</h3>
      <div class="detail-files">${files.map(f =>
        `<span class="file-tag" title="${esc(f.file_path)}">${esc(f.file_path.split('\\').pop().split('/').pop())}</span>`
      ).join('')}</div></div>`;
  }

  if (checkpoints?.length) {
    html += `<div class="detail-section"><h3>Summary</h3>
      <div class="conversation">${checkpoints.map(c => `
        <div class="turn assistant">
          <div class="turn-label">${esc(c.title || 'Checkpoint ' + c.checkpoint_number)}</div>
          <div class="turn-content">${esc(c.overview || c.work_done || '')}</div>
        </div>`).join('')}</div></div>`;
  }

  if (turns?.length) {
    html += `<div class="detail-section"><h3>Conversation (${turns.length} turns)</h3>
      <div class="conversation">${turns.map(t => {
        let out = '';
        if (t.user_message) out += `<div class="turn user"><div class="turn-label">You</div><div class="turn-content">${esc(t.user_message)}</div></div>`;
        if (t.assistant_response) out += `<div class="turn assistant"><div class="turn-label">Copilot</div><div class="turn-content">${esc(t.assistant_response.substring(0, 2000))}${t.assistant_response.length > 2000 ? '…' : ''}</div></div>`;
        return out;
      }).join('')}</div></div>`;
  }

  el.innerHTML = html;
}

async function _launchCopilotTerminal(projectId) {
  const p = projects.find(p => p.id === projectId);
  const id = `copilot-${projectId}-${Date.now()}`;
  panel.tabs.push({ id, type: 'terminal', projectId, label: p?.name || projectId, icon: '🤖' });

  const body = document.getElementById('panel-body');
  const pane = document.createElement('div');
  pane.className = 'panel-pane';
  pane.dataset.tabId = id;
  pane.innerHTML = `<div class="terminal-container" id="tc-${id}"></div>`;
  body.appendChild(pane);

  panel.activate(id);
  panel.open();

  const xterm = new Terminal({
    theme: {
      background: '#060d19', foreground: '#e2e8f0', cursor: '#22d3ee', cursorAccent: '#060d19',
      selectionBackground: 'rgba(34,211,238,0.3)',
      black: '#0d1a2d', red: '#ef4444', green: '#22c55e', yellow: '#f59e0b',
      blue: '#22d3ee', magenta: '#a855f7', cyan: '#2dd4bf', white: '#e2e8f0',
      brightBlack: '#4a5e78', brightRed: '#f87171', brightGreen: '#4ade80',
      brightYellow: '#fbbf24', brightBlue: '#67e8f9', brightMagenta: '#c084fc',
      brightCyan: '#5eead4', brightWhite: '#f8fafc',
    },
    fontFamily: "'Geist Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace",
    fontSize: 13, lineHeight: 1.3, cursorBlink: true, allowProposedApi: true,
  });

  const fitAddon = new FitAddon.FitAddon();
  xterm.loadAddon(fitAddon);
  try { xterm.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch {}

  const container = document.getElementById(`tc-${id}`);
  xterm.open(container);
  setTimeout(() => fitAddon.fit(), 50);

  panel.termInstances.set(id, { xterm, fitAddon });

  socket.emit('terminal:create', { termId: id, projectId });

  // Block user input while session is restoring
  let inputBlocked = true;
  xterm.onData(data => {
    if (!inputBlocked) socket.emit('terminal:input', { termId: id, data });
  });
  xterm.onResize(({ cols, rows }) => socket.emit('terminal:resize', { termId: id, cols, rows }));
  enableTermClipboard(xterm, id);

  // Unblock input once Copilot is ready or shows an interactive prompt
  const unblockOnReady = ({ termId: tid, data: out }) => {
    if (tid !== id) return;
    if (out.includes('Describe a task') || out.includes('shift+tab') || out.includes('reqs.')
        || out.includes('Session storage') || out.includes('to navigate') || out.includes('to confirm')) {
      inputBlocked = false;
      socket.off('terminal:output', unblockOnReady);
    }
  };
  socket.on('terminal:output', unblockOnReady);
  setTimeout(() => { inputBlocked = false; socket.off('terminal:output', unblockOnReady); }, 60000);

  // Find last session for this project and resume it, or start fresh
  let cmd = 'copilot --autopilot';
  let isResuming = false;
  let resumeSessionId = null;
  try {
    const res = await fetch(`/api/sessions/last-id/${projectId}`);
    const data = await res.json();
    if (data.sessionId) {
      cmd = `copilot --autopilot --resume=${data.sessionId}`;
      resumeSessionId = data.sessionId;
      isResuming = true;
    }
  } catch {}

  // Watch for repeated 400 errors — if resume fails, auto-restart fresh with context
  if (isResuming) {
    let errorCount = 0;
    let outputBuffer = '';
    const onOutput = ({ termId: tid, data }) => {
      if (tid !== id) return;
      outputBuffer += data;
      if (outputBuffer.includes('400 Bad Request') || outputBuffer.includes('CAPIError: 400')) {
        errorCount++;
        outputBuffer = '';
        if (errorCount >= 2) {
          socket.off('terminal:output', onOutput);
          xterm.writeln('\r\n\x1b[33m⚠ Resumed session rejected by API — restarting fresh with context...\x1b[0m\r\n');
          socket.emit('terminal:input', { termId: id, data: 'exit\r' });

          // Fetch previous session summary to hand off as context
          let contextMsg = null;
          fetch(`/api/sessions/${resumeSessionId}`).then(r => r.json()).then(sData => {
            const parts = [];
            if (sData.session?.summary) parts.push(sData.session.summary);
            if (sData.checkpoints?.length) {
              const last = sData.checkpoints[sData.checkpoints.length - 1];
              if (last.overview) parts.push(last.overview);
              if (last.work_done) parts.push('Recent work: ' + last.work_done.substring(0, 500));
            }
            if (parts.length) contextMsg = parts.join('\n\n');
          }).catch(() => {}).finally(() => {
            setTimeout(() => {
              socket.emit('terminal:create', { termId: id, projectId });
              setTimeout(() => {
                socket.emit('terminal:input', { termId: id, data: 'copilot --autopilot\r' });
                // After copilot starts, send the previous session context as first message
                if (contextMsg) {
                  const escaped = contextMsg.replace(/\r?\n/g, ' ').substring(0, 800);
                  setTimeout(() => {
                    socket.emit('terminal:input', { termId: id, data: `Previous session (completed) context: ${escaped}\r` });
                  }, 5000);
                }
              }, 1500);
            }, 1000);
          });
        }
      }
      if (outputBuffer.length > 10000) outputBuffer = outputBuffer.slice(-2000);
    };
    socket.on('terminal:output', onOutput);
    setTimeout(() => socket.off('terminal:output', onOutput), 60000);
  }

  setTimeout(() => socket.emit('terminal:input', { termId: id, data: cmd + '\r' }), 1500);
  xterm.focus();
}

// ── Init ────────────────────────────────────────────
api.loadProjects();
