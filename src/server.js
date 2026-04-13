const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn, exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

let pty = null;
try { pty = require('node-pty'); } catch { console.warn('⚠ node-pty unavailable — terminals disabled'); }

const Database = require('better-sqlite3');
const SESSION_STORE = path.join(process.env.USERPROFILE || process.env.HOME || '', '.copilot', 'session-store.db');

const PORT = 9900;
const HEALTH_INTERVAL = 8000;
const MAX_LOG_LINES = 500;
const STARTUP_GRACE_MS = 45000;
const ICONS_DIR = path.join(__dirname, '..', 'public', 'icons');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Icon upload storage
const iconStorage = multer.diskStorage({
  destination: ICONS_DIR,
  filename: (req, file, cb) => cb(null, req.params.id + path.extname(file.originalname)),
});
const iconUpload = multer({ storage: iconStorage, limits: { fileSize: 2 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
  if (/^image\/(png|jpeg|gif|svg\+xml|webp|x-icon|vnd\.microsoft\.icon)$/.test(file.mimetype)) cb(null, true);
  else cb(new Error('Only image files allowed'));
}});

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Config ──────────────────────────────────────────
const configPath = path.join(__dirname, '..', 'projects.json');
function loadConfig() {
  if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, JSON.stringify({ projects: [] }, null, 2));
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}
function saveConfig(cfg) { fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2)); }

// ── State ───────────────────────────────────────────
const states = new Map();

function getState(id) {
  if (!states.has(id)) {
    states.set(id, {
      proc: null,
      pid: null,
      status: 'stopped',
      logs: [],
      startedAt: null,
      external: false,
      memory: null,
    });
  }
  return states.get(id);
}

function addLog(id, type, msg) {
  const state = getState(id);
  const entry = { time: new Date().toISOString(), type, message: String(msg).trimEnd() };
  state.logs.push(entry);
  if (state.logs.length > MAX_LOG_LINES) state.logs = state.logs.slice(-MAX_LOG_LINES);
  io.emit('project:log', { id, ...entry });
}

function setStatus(id, status) {
  const state = getState(id);
  if (state.status !== status) {
    state.status = status;
    io.emit('project:status', { id, status, pid: state.pid, external: state.external });
  }
}

function findPidByPort(port) {
  try {
    const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
      encoding: 'utf-8', timeout: 5000,
    });
    for (const line of out.trim().split('\n')) {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[parts.length - 1]);
      if (pid > 0) return pid;
    }
  } catch {}
  return null;
}

// ── Health Check ────────────────────────────────────
async function healthCheck(id) {
  const config = loadConfig();
  const project = config.projects.find(p => p.id === id);
  const state = getState(id);
  if (!project?.healthUrl) return;

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    await fetch(project.healthUrl, { signal: ctrl.signal });
    clearTimeout(t);

    if (state.status !== 'running') {
      if (!state.proc && state.status !== 'stopping' && state.status !== 'starting') {
        state.external = true;
        state.pid = findPidByPort(project.port);
      }
      setStatus(id, 'running');
      if (state.external) {
        addLog(id, 'system', `✓ Detected running externally (PID ${state.pid || '?'}) on port ${project.port}`);
        addLog(id, 'system', 'ℹ Stdout/stderr logs only available for projects started through Control Center');
      } else {
        addLog(id, 'system', '✓ Health check passed — service is up');
      }
    }
  } catch {
    const isGrace = state.startedAt && (Date.now() - state.startedAt < STARTUP_GRACE_MS);
    if (state.status === 'running') {
      setStatus(id, state.proc ? 'error' : 'stopped');
      if (!state.proc) { state.pid = null; state.external = false; }
      addLog(id, 'system', '✗ Health check failed');
    } else if (state.status === 'starting' && !isGrace) {
      setStatus(id, 'error');
      addLog(id, 'system', '✗ Startup timed out');
    }
  }
}

// ── Start / Stop ────────────────────────────────────
function startProject(id) {
  const config = loadConfig();
  const project = config.projects.find(p => p.id === id);
  const state = getState(id);
  if (!project) throw new Error('Project not found');

  // If running externally, kill external process first so CC can take over
  if (state.status === 'running' && state.external) {
    const killPid = state.pid || findPidByPort(project.port);
    if (killPid) {
      addLog(id, 'system', 'Taking over from external process...');
      try { execSync(`taskkill /T /F /PID ${killPid}`, { timeout: 5000 }); } catch {}
    }
    state.proc = null;
    state.pid = null;
    state.external = false;
    state.status = 'stopped';
  }

  if (state.proc || state.status === 'running') throw new Error('Already running');

  // Kill anything still holding the port before we start
  const blockingPid = findPidByPort(project.port);
  if (blockingPid) {
    addLog(id, 'system', `Killing process ${blockingPid} blocking port ${project.port}...`);
    try { execSync(`taskkill /T /F /PID ${blockingPid}`, { timeout: 5000 }); } catch {}
    // Brief pause to let the port free up
    execSync('timeout /t 1 /nobreak >nul', { timeout: 3000 });
  }

  setStatus(id, 'starting');
  state.startedAt = Date.now();
  state.external = false;
  addLog(id, 'system', `Starting ${project.name}...`);

  const env = { ...process.env, ...(project.env || {}), PORT: String(project.port) };
  const proc = spawn(project.startCommand, {
    cwd: project.path,
    env,
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  state.proc = proc;
  state.pid = proc.pid;

  proc.stdout?.on('data', d => {
    d.toString().split('\n').filter(l => l.trim()).forEach(l => addLog(id, 'stdout', l));
  });
  proc.stderr?.on('data', d => {
    d.toString().split('\n').filter(l => l.trim()).forEach(l => addLog(id, 'stderr', l));
  });
  proc.on('exit', (code) => {
    addLog(id, 'system', `Exited (code: ${code})`);
    state.proc = null;
    state.pid = null;
    setStatus(id, state.status === 'stopping' ? 'stopped' : (code === 0 || code === null ? 'stopped' : 'error'));
  });
  proc.on('error', err => {
    addLog(id, 'system', `Error: ${err.message}`);
    state.proc = null;
    setStatus(id, 'error');
  });
}

function stopProject(id) {
  const config = loadConfig();
  const project = config.projects.find(p => p.id === id);
  const state = getState(id);
  if (state.status === 'stopped') throw new Error('Not running');

  setStatus(id, 'stopping');
  addLog(id, 'system', 'Stopping...');

  const killPid = state.pid || (project && findPidByPort(project.port));
  if (killPid) {
    exec(`taskkill /T /F /PID ${killPid}`, () => {
      setTimeout(() => {
        if (getState(id).status === 'stopping') {
          state.proc = null;
          state.pid = null;
          state.external = false;
          setStatus(id, 'stopped');
        }
      }, 2000);
    });
  } else {
    state.proc = null;
    state.pid = null;
    state.external = false;
    setStatus(id, 'stopped');
  }
}

// ── API Routes ──────────────────────────────────────
app.get('/api/projects', (req, res) => {
  const config = loadConfig();
  res.json(config.projects.map(p => {
    const s = getState(p.id);
    return { ...p, status: s.status, pid: s.pid, external: s.external, logCount: s.logs.length, memory: s.memory || null };
  }));
});

app.post('/api/projects/:id/start', (req, res) => {
  try { startProject(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/projects/:id/stop', (req, res) => {
  try { stopProject(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/projects/:id/restart', async (req, res) => {
  try {
    const id = req.params.id;
    const state = getState(id);
    if (state.status !== 'stopped') {
      stopProject(id);
      await new Promise(resolve => {
        const iv = setInterval(() => {
          if (getState(id).status === 'stopped') { clearInterval(iv); resolve(); }
        }, 500);
        setTimeout(() => { clearInterval(iv); resolve(); }, 10000);
      });
    }
    startProject(id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/projects/:id/logs', (req, res) => {
  res.json(getState(req.params.id).logs.slice(-(parseInt(req.query.limit) || 200)));
});

app.post('/api/projects/start-all', async (req, res) => {
  const config = loadConfig();
  const results = [];
  for (const p of config.projects) {
    const s = getState(p.id);
    if (s.status === 'stopped' || s.status === 'error') {
      try { startProject(p.id); results.push({ id: p.id, ok: true }); }
      catch (e) { results.push({ id: p.id, error: e.message }); }
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  res.json(results);
});

app.post('/api/projects/restart-all', async (req, res) => {
  const config = loadConfig();
  const results = [];
  for (const p of config.projects) {
    const s = getState(p.id);
    if (s.status === 'running') {
      try {
        stopProject(p.id);
        await new Promise(r => setTimeout(r, 1500));
        startProject(p.id);
        results.push({ id: p.id, ok: true });
      } catch (e) { results.push({ id: p.id, error: e.message }); }
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  res.json(results);
});

app.post('/api/projects/stop-all', (req, res) => {
  const config = loadConfig();
  const results = [];
  for (const p of config.projects) {
    if (getState(p.id).status !== 'stopped') {
      try { stopProject(p.id); results.push({ id: p.id, ok: true }); }
      catch (e) { results.push({ id: p.id, error: e.message }); }
    }
  }
  res.json(results);
});

app.post('/api/projects/:id/toggle-autostart', (req, res) => {
  const config = loadConfig();
  const p = config.projects.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  p.autoStart = !p.autoStart;
  saveConfig(config);
  res.json({ autoStart: p.autoStart });
});

app.post('/api/projects/:id/toggle-hidden', (req, res) => {
  const config = loadConfig();
  const p = config.projects.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  p.hidden = !p.hidden;
  saveConfig(config);
  res.json({ hidden: p.hidden });
});

app.post('/api/projects/:id/open', (req, res) => {
  const config = loadConfig();
  const p = config.projects.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  exec(`start chrome "${p.url}"`);
  res.json({ ok: true });
});

app.post('/api/projects/:id/open-production', (req, res) => {
  const config = loadConfig();
  const p = config.projects.find(p => p.id === req.params.id);
  if (!p?.productionUrl) return res.status(400).json({ error: 'No production URL' });
  exec(`start chrome "${p.productionUrl}"`);
  res.json({ ok: true });
});

app.post('/api/projects/:id/open-folder', (req, res) => {
  const config = loadConfig();
  const p = config.projects.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  exec(`explorer "${p.path}"`);
  res.json({ ok: true });
});

app.post('/api/projects/:id/open-github', (req, res) => {
  const config = loadConfig();
  const p = config.projects.find(p => p.id === req.params.id);
  if (!p?.githubUrl) return res.status(400).json({ error: 'No GitHub URL' });
  exec(`start chrome "${p.githubUrl}"`);
  res.json({ ok: true });
});

// Detect GitHub remote URL from a project's .git/config
function detectGithubUrl(projectPath) {
  try {
    const gitConfig = path.join(projectPath, '.git', 'config');
    if (!fs.existsSync(gitConfig)) return null;
    const content = fs.readFileSync(gitConfig, 'utf-8');
    const match = content.match(/url\s*=\s*(.+github\.com.+)/i);
    if (!match) return null;
    let url = match[1].trim();
    // Convert git@github.com:user/repo.git to https URL
    url = url.replace(/^git@github\.com:/, 'https://github.com/');
    // Remove .git suffix
    url = url.replace(/\.git$/, '');
    return url;
  } catch { return null; }
}

// Icon upload endpoint
app.post('/api/projects/:id/icon', iconUpload.single('icon'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const config = loadConfig();
  const p = config.projects.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  p.iconPath = `/icons/${req.file.filename}`;
  saveConfig(config);
  res.json({ ok: true, iconPath: p.iconPath });
});

// Delete custom icon
app.delete('/api/projects/:id/icon', (req, res) => {
  const config = loadConfig();
  const p = config.projects.find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.iconPath) {
    const file = path.join(__dirname, '..', 'public', p.iconPath);
    try { fs.unlinkSync(file); } catch {}
    delete p.iconPath;
    saveConfig(config);
  }
  res.json({ ok: true });
});

// Icon search via Iconify API
app.get('/api/icons/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json({ icons: [] });

    // Search colored/brand icon sets first, then general palette icons
    const colorSets = 'logos,skill-icons,vscode-icons,flat-color-icons,noto,twemoji,openmoji,fluent-emoji,fluent-emoji-flat,fxemoji,devicon,circle-flags,flagpack,token-branded';
    const [colorResp, generalResp] = await Promise.all([
      fetch(`https://api.iconify.design/search?query=${encodeURIComponent(q)}&limit=30&prefixes=${colorSets}`).then(r => r.json()).catch(() => ({ icons: [] })),
      fetch(`https://api.iconify.design/search?query=${encodeURIComponent(q)}&limit=30`).then(r => r.json()).catch(() => ({ icons: [] })),
    ]);

    // Dedupe, color results first
    const seen = new Set();
    const allNames = [];
    for (const name of [...(colorResp.icons || []), ...(generalResp.icons || [])]) {
      if (!seen.has(name)) { seen.add(name); allNames.push(name); }
    }

    const icons = allNames.slice(0, 50).map(name => {
      const [prefix, ...rest] = name.split(':');
      const iconName = rest.join(':');
      return { name, prefix, iconName, svgUrl: `https://api.iconify.design/${prefix}/${iconName}.svg?height=64` };
    });
    res.json({ icons });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Download an Iconify icon and save it for a project
app.post('/api/projects/:id/icon-download', async (req, res) => {
  try {
    const { svgUrl, iconName } = req.body;
    if (!svgUrl) return res.status(400).json({ error: 'No URL provided' });
    const config = loadConfig();
    const p = config.projects.find(p => p.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });

    // Download the SVG
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const resp = await fetch(svgUrl, { signal: ctrl.signal });
    clearTimeout(t);
    const svg = await resp.text();

    // Save to icons folder
    const filename = `${req.params.id}.svg`;
    fs.writeFileSync(path.join(ICONS_DIR, filename), svg);

    // Delete old custom icon if different
    if (p.iconPath && p.iconPath !== `/icons/${filename}`) {
      const oldFile = path.join(__dirname, '..', 'public', p.iconPath);
      try { fs.unlinkSync(oldFile); } catch {}
    }

    p.iconPath = `/icons/${filename}`;
    p.icon = iconName || '📦';
    saveConfig(config);
    res.json({ ok: true, iconPath: p.iconPath });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Create New Project (scaffold folder) ────────────
app.post('/api/projects/create', (req, res) => {
  const config = loadConfig();
  const { name, folder } = req.body;
  if (!name || !folder) return res.status(400).json({ error: 'Name and folder are required' });

  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (config.projects.find(p => p.id === id)) return res.status(400).json({ error: 'Project ID already exists' });

  // Create directory if it doesn't exist
  const projPath = path.resolve(folder);
  try {
    if (!fs.existsSync(projPath)) fs.mkdirSync(projPath, { recursive: true });
  } catch (e) {
    return res.status(500).json({ error: `Failed to create folder: ${e.message}` });
  }

  const project = {
    id,
    name,
    icon: '📦',
    path: projPath,
    startCommand: 'npm start',
    port: 3000,
    healthUrl: 'http://localhost:3000',
    url: 'http://localhost:3000',
    autoStart: false,
    description: '',
    searchTerms: [name.toLowerCase()],
  };

  // Auto-detect GitHub URL
  const githubUrl = detectGithubUrl(projPath);
  if (githubUrl) project.githubUrl = githubUrl;

  config.projects.push(project);
  saveConfig(config);
  res.json(project);
});

// ── Project CRUD ────────────────────────────────────
app.post('/api/projects', (req, res) => {
  const config = loadConfig();
  const { name, icon, path: projPath, startCommand, port, description } = req.body;
  if (!name || !projPath) return res.status(400).json({ error: 'Name and path are required' });

  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (config.projects.find(p => p.id === id)) return res.status(400).json({ error: 'Project ID already exists' });

  const project = {
    id,
    name,
    icon: icon || '📦',
    path: projPath,
    startCommand: startCommand || 'npm start',
    port: parseInt(port) || 3000,
    healthUrl: `http://localhost:${parseInt(port) || 3000}`,
    url: `http://localhost:${parseInt(port) || 3000}`,
    autoStart: false,
    description: description || '',
    searchTerms: [name.toLowerCase()],
  };
  config.projects.push(project);
  saveConfig(config);
  res.json(project);
});

app.put('/api/projects/:id', (req, res) => {
  const config = loadConfig();
  const idx = config.projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const allowed = ['name', 'icon', 'path', 'startCommand', 'port', 'description', 'url', 'healthUrl', 'env', 'searchTerms', 'productionUrl', 'githubUrl'];
  const project = config.projects[idx];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      project[key] = key === 'port' ? parseInt(req.body[key]) : req.body[key];
    }
  }
  // Keep healthUrl and url in sync with port if not explicitly set
  if (req.body.port && !req.body.healthUrl) project.healthUrl = `http://localhost:${project.port}`;
  if (req.body.port && !req.body.url) project.url = `http://localhost:${project.port}`;
  // Keep env.PORT in sync
  if (req.body.port) {
    if (!project.env) project.env = {};
    project.env.PORT = String(project.port);
  }

  saveConfig(config);
  res.json(project);
});

// Reorder projects
app.post('/api/projects/reorder', (req, res) => {
  const { order } = req.body; // array of project IDs in new order
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array' });
  const config = loadConfig();
  const byId = new Map(config.projects.map(p => [p.id, p]));
  const reordered = order.filter(id => byId.has(id)).map(id => byId.get(id));
  // Append any projects not in the order array (safety net)
  for (const p of config.projects) {
    if (!order.includes(p.id)) reordered.push(p);
  }
  config.projects = reordered;
  saveConfig(config);
  res.json({ ok: true });
});

app.delete('/api/projects/:id', (req, res) => {
  const config = loadConfig();
  const idx = config.projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const state = getState(req.params.id);
  if (state.status === 'running') return res.status(400).json({ error: 'Stop the project first' });

  const removed = config.projects.splice(idx, 1)[0];
  saveConfig(config);
  states.delete(req.params.id);
  res.json({ ok: true, removed: removed.name });
});

// ── Session Store API ───────────────────────────────
function withSessionDb(fn) {
  if (!fs.existsSync(SESSION_STORE)) return null;
  let db;
  try {
    db = new Database(SESSION_STORE, { readonly: true, fileMustExist: true });
    return fn(db);
  } finally { if (db) db.close(); }
}

app.get('/api/sessions', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const rows = withSessionDb(db =>
      db.prepare(`SELECT id, cwd, repository, branch, summary, created_at, updated_at
                  FROM sessions ORDER BY created_at DESC LIMIT ?`).all(limit)
    );
    res.json(rows || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sessions/search', (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json([]);
    const rows = withSessionDb(db =>
      db.prepare(`SELECT content, session_id, source_type FROM search_index
                  WHERE search_index MATCH ? ORDER BY rank LIMIT 30`).all(q)
    );
    res.json(rows || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sessions/for-project', (req, res) => {
  try {
    const projectId = req.query.projectId;
    const cfg = loadConfig();
    const project = cfg.projects.find(p => p.id === projectId);
    if (!project) return res.json(null);

    const data = withSessionDb(db => {
      let sessionId = null;

      // Strategy 1: match session_files by project path
      const byFiles = db.prepare(
        `SELECT DISTINCT s.id FROM sessions s
         JOIN session_files sf ON sf.session_id = s.id
         WHERE sf.file_path LIKE ? ORDER BY s.created_at DESC LIMIT 1`
      ).get(project.path + '%');
      if (byFiles) sessionId = byFiles.id;

      // Strategy 2: match by CWD
      if (!sessionId) {
        const byCwd = db.prepare(
          `SELECT id FROM sessions WHERE cwd LIKE ? ORDER BY created_at DESC LIMIT 1`
        ).get(project.path + '%');
        if (byCwd) sessionId = byCwd.id;
      }

      // Strategy 3: FTS search using project searchTerms
      if (!sessionId && project.searchTerms?.length) {
        const ftsQuery = project.searchTerms.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
        try {
          const byFts = db.prepare(
            `SELECT DISTINCT session_id FROM search_index
             WHERE search_index MATCH ? ORDER BY rank LIMIT 1`
          ).get(ftsQuery);
          if (byFts) sessionId = byFts.session_id;
        } catch {}
      }

      // Strategy 4: match summary by project name
      if (!sessionId) {
        const words = project.name.split(/\s+/).map(w => `%${w}%`);
        for (const w of words) {
          const bySummary = db.prepare(
            `SELECT id FROM sessions WHERE summary LIKE ? ORDER BY created_at DESC LIMIT 1`
          ).get(w);
          if (bySummary) { sessionId = bySummary.id; break; }
        }
      }

      if (!sessionId) return null;

      const session = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId);
      const turns = db.prepare(
        `SELECT turn_index, user_message, assistant_response, timestamp
         FROM turns WHERE session_id = ? ORDER BY turn_index`
      ).all(sessionId);
      const files = db.prepare(
        `SELECT file_path, tool_name, turn_index, first_seen_at
         FROM session_files WHERE session_id = ? ORDER BY turn_index`
      ).all(sessionId);
      const checkpoints = db.prepare(
        `SELECT checkpoint_number, title, overview, work_done
         FROM checkpoints WHERE session_id = ? ORDER BY checkpoint_number`
      ).all(sessionId);

      // Also grab all sessions for this project (for the sidebar list)
      const allSessionIds = new Set();
      // by files
      db.prepare(`SELECT DISTINCT s.id FROM sessions s JOIN session_files sf ON sf.session_id = s.id WHERE sf.file_path LIKE ?`)
        .all(project.path + '%').forEach(r => allSessionIds.add(r.id));
      // by FTS
      if (project.searchTerms?.length) {
        const fq = project.searchTerms.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
        try {
          db.prepare(`SELECT DISTINCT session_id FROM search_index WHERE search_index MATCH ?`)
            .all(fq).forEach(r => allSessionIds.add(r.session_id));
        } catch {}
      }
      // by summary keywords
      project.name.split(/\s+/).forEach(w => {
        db.prepare(`SELECT id FROM sessions WHERE summary LIKE ?`).all(`%${w}%`).forEach(r => allSessionIds.add(r.id));
      });

      const allSessions = allSessionIds.size > 0
        ? db.prepare(`SELECT id, summary, created_at, cwd FROM sessions WHERE id IN (${[...allSessionIds].map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 20`).all(...allSessionIds)
        : [];

      return { session, turns, files, checkpoints, relatedSessions: allSessions };
    });

    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sessions/last-id/:projectId', (req, res) => {
  try {
    const projectId = req.params.projectId;
    const cfg = loadConfig();
    const project = cfg.projects.find(p => p.id === projectId);
    if (!project) return res.json({ sessionId: null });

    const sessionId = withSessionDb(db => {
      const pathVariants = [project.path, project.path.replace(/\\/g, '/')];

      // Strategy 1: match session_files by project path
      for (const p of pathVariants) {
        const byFiles = db.prepare(
          `SELECT DISTINCT s.id FROM sessions s
           JOIN session_files sf ON sf.session_id = s.id
           WHERE sf.file_path LIKE ? ORDER BY s.created_at DESC LIMIT 1`
        ).get(p + '%');
        if (byFiles) return byFiles.id;
      }

      // Strategy 2: match by CWD
      for (const p of pathVariants) {
        const byCwd = db.prepare(
          `SELECT id FROM sessions WHERE cwd LIKE ? ORDER BY created_at DESC LIMIT 1`
        ).get(p + '%');
        if (byCwd) return byCwd.id;
      }

      return null;
    });

    res.json({ sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sessions/:id', (req, res) => {
  try {
    const id = req.params.id;
    const data = withSessionDb(db => {
      const session = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);
      const turns = db.prepare(`SELECT turn_index, user_message, assistant_response, timestamp
                                FROM turns WHERE session_id = ? ORDER BY turn_index`).all(id);
      const files = db.prepare(`SELECT file_path, tool_name, turn_index, first_seen_at
                                FROM session_files WHERE session_id = ? ORDER BY turn_index`).all(id);
      const checkpoints = db.prepare(`SELECT checkpoint_number, title, overview, work_done
                                      FROM checkpoints WHERE session_id = ? ORDER BY checkpoint_number`).all(id);
      return { session, turns, files, checkpoints };
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Socket.IO + Terminals ───────────────────────────
const terminals = new Map();

io.on('connection', socket => {
  const config = loadConfig();
  for (const p of config.projects) {
    const s = getState(p.id);
    socket.emit('project:status', { id: p.id, status: s.status, pid: s.pid, external: s.external });
  }

  socket.emit('pty:available', !!pty);

  socket.on('terminal:create', ({ termId, projectId }) => {
    if (!pty) return socket.emit('terminal:error', { termId, error: 'node-pty not available' });
    const cfg = loadConfig();
    const project = cfg.projects.find(p => p.id === projectId);
    let cwd = project ? project.path : process.cwd();
    // Validate CWD exists, fallback to home dir
    try { if (!fs.existsSync(cwd)) cwd = process.cwd(); } catch { cwd = process.cwd(); }
    const env = { ...process.env, ...(project?.env || {}) };

    const shell = 'powershell.exe';
    let term;
    try {
      term = pty.spawn(shell, ['-NoLogo'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 24,
        cwd,
        env,
      });
    } catch (e) {
      socket.emit('terminal:error', { termId, error: e.message });
      return;
    }

    terminals.set(termId, { pty: term, socketId: socket.id });

    term.onData(data => socket.emit('terminal:output', { termId, data }));
    term.onExit(({ exitCode }) => {
      terminals.delete(termId);
      socket.emit('terminal:exit', { termId, exitCode });
    });
  });

  socket.on('terminal:input', ({ termId, data }) => {
    const t = terminals.get(termId);
    if (t) t.pty.write(data);
  });

  socket.on('terminal:resize', ({ termId, cols, rows }) => {
    const t = terminals.get(termId);
    if (t) t.pty.resize(Math.max(cols, 2), Math.max(rows, 2));
  });

  socket.on('terminal:close', ({ termId }) => {
    const t = terminals.get(termId);
    if (t) { t.pty.kill(); terminals.delete(termId); }
  });

  socket.on('disconnect', () => {
    for (const [id, t] of terminals) {
      if (t.socketId === socket.id) { t.pty.kill(); terminals.delete(id); }
    }
  });
});

// ── Memory Collection ────────────────────────────────
function collectMemory() {
  const pidsMap = new Map();
  for (const [id, state] of states) {
    if (state.pid && (state.status === 'running' || state.status === 'starting')) {
      pidsMap.set(state.pid, id);
    }
  }
  if (!pidsMap.size) return;

  exec('tasklist /FO CSV /NH', { timeout: 5000 }, (err, stdout) => {
    if (err || !stdout) return;
    for (const line of stdout.split('\n')) {
      const parts = line.match(/"([^"]*)"/g);
      if (!parts || parts.length < 5) continue;
      const pid = parseInt(parts[1].replace(/"/g, ''));
      if (!pidsMap.has(pid)) continue;
      const memKB = parseInt(parts[4].replace(/"/g, '').replace(/[^0-9]/g, ''));
      if (isNaN(memKB)) continue;
      const projectId = pidsMap.get(pid);
      const state = getState(projectId);
      state.memory = memKB * 1024;
      io.emit('project:memory', { id: projectId, memory: state.memory });
    }
  });
}

// ── Health Loop ─────────────────────────────────────
setInterval(() => {
  const config = loadConfig();
  config.projects.forEach(p => healthCheck(p.id));
  collectMemory();
}, HEALTH_INTERVAL);

// ── Auto-start ──────────────────────────────────────
async function init() {
  const config = loadConfig();

  // Auto-detect GitHub URLs from .git/config
  let configChanged = false;
  for (const p of config.projects) {
    if (!p.githubUrl && p.path) {
      const detected = detectGithubUrl(p.path);
      if (detected) {
        p.githubUrl = detected;
        configChanged = true;
      }
    }
  }
  if (configChanged) saveConfig(config);

  console.log('🔍 Scanning for running projects...');
  await Promise.all(config.projects.map(p => healthCheck(p.id)));
  await new Promise(r => setTimeout(r, 2000));

  const autoProjects = config.projects.filter(p => p.autoStart);
  for (const p of autoProjects) {
    const s = getState(p.id);
    if (s.status === 'running') {
      console.log(`  ✓ ${p.name} — already running`);
    } else {
      console.log(`  🚀 ${p.name} — starting...`);
      try { startProject(p.id); } catch (e) { console.error(`  ✗ ${p.name}: ${e.message}`); }
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  console.log('\n  Ready.\n');
}

// ── Launch ──────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🌀 Control Tower → http://localhost:${PORT}\n`);
  init();
});

process.on('SIGINT', () => { console.log('\n👋 Bye'); process.exit(0); });
