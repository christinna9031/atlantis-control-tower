const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const crypto = require('crypto');
function uuidv4() { return crypto.randomUUID(); }

const PORT = parseInt(process.env.PORT, 10) || 3100;
const DB_PATH = path.join(__dirname, 'data', 'dashboard.db');

// Ensure data directory exists
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema Migrations ───────────────────────────────
function runMigrations() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`);
  const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get();
  const current = row?.v || 0;

  const migrations = [
    // v1: initial schema
    () => {
      db.exec(`
        CREATE TABLE customers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          org TEXT DEFAULT '',
          slug TEXT UNIQUE NOT NULL,
          cre_role TEXT NOT NULL DEFAULT 'primary' CHECK(cre_role IN ('primary','secondary')),
          slack_channel TEXT DEFAULT '',
          ghes_version TEXT DEFAULT '',
          contract_tier TEXT DEFAULT '',
          avatar_color TEXT DEFAULT '#6366f1',
          notes_general TEXT DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE notes (
          id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          title TEXT DEFAULT '',
          body TEXT NOT NULL DEFAULT '',
          source TEXT DEFAULT 'manual',
          external_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(customer_id, source, external_id)
        );
        CREATE INDEX idx_notes_customer ON notes(customer_id);

        CREATE TABLE zendesk_tickets (
          id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          ticket_number TEXT,
          subject TEXT DEFAULT '',
          status TEXT DEFAULT '',
          priority TEXT DEFAULT '',
          summary TEXT DEFAULT '',
          requester TEXT DEFAULT '',
          assigned_to TEXT DEFAULT '',
          source TEXT DEFAULT 'manual',
          external_id TEXT,
          ticket_created_at TEXT,
          ticket_updated_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(customer_id, source, external_id)
        );
        CREATE INDEX idx_tickets_customer ON zendesk_tickets(customer_id);

        CREATE TABLE meetings (
          id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          title TEXT DEFAULT '',
          meeting_date TEXT,
          attendees TEXT DEFAULT '',
          summary TEXT DEFAULT '',
          action_items_text TEXT DEFAULT '',
          source TEXT DEFAULT 'manual',
          external_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(customer_id, source, external_id)
        );
        CREATE INDEX idx_meetings_customer ON meetings(customer_id);

        CREATE TABLE action_items (
          id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          description TEXT DEFAULT '',
          status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','done','blocked')),
          owner TEXT DEFAULT '',
          due_date TEXT,
          source TEXT DEFAULT 'manual',
          external_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(customer_id, source, external_id)
        );
        CREATE INDEX idx_actions_customer ON action_items(customer_id);

        CREATE TABLE health_checks (
          id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          check_date TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'healthy' CHECK(status IN ('healthy','warning','critical','unknown')),
          category TEXT DEFAULT 'general',
          notes TEXT DEFAULT '',
          next_check_due TEXT,
          source TEXT DEFAULT 'manual',
          external_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(customer_id, source, external_id)
        );
        CREATE INDEX idx_health_customer ON health_checks(customer_id);
      `);
    },
  ];

  for (let i = current; i < migrations.length; i++) {
    db.transaction(() => {
      migrations[i]();
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(i + 1);
    })();
    console.log(`✔ Migration ${i + 1} applied`);
  }
}

runMigrations();

// ── Helpers ─────────────────────────────────────────
function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function uniqueSlug(name, excludeId) {
  let base = slugify(name);
  if (!base) base = 'customer';
  let slug = base;
  let i = 2;
  while (true) {
    const existing = db.prepare('SELECT id FROM customers WHERE slug = ? AND id != ?').get(slug, excludeId || '');
    if (!existing) return slug;
    slug = `${base}-${i++}`;
  }
}

function now() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

// ── Express App ─────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health endpoint
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ── Customers CRUD ──────────────────────────────────
app.get('/api/customers', (req, res) => {
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM action_items WHERE customer_id=c.id AND status IN ('open','in_progress')) as open_actions,
      (SELECT COUNT(*) FROM zendesk_tickets WHERE customer_id=c.id AND status NOT IN ('solved','closed','')) as open_tickets,
      (SELECT status FROM health_checks WHERE customer_id=c.id ORDER BY check_date DESC LIMIT 1) as latest_health
    FROM customers c ORDER BY c.name
  `).all();
  res.json(rows);
});

app.get('/api/customers/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
});

app.get('/api/customers/:id/overview', (req, res) => {
  const id = req.params.id;
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ error: 'Not found' });

  const notes_count = db.prepare('SELECT COUNT(*) as c FROM notes WHERE customer_id=?').get(id).c;
  const recent_notes = db.prepare('SELECT id, title, created_at FROM notes WHERE customer_id=? ORDER BY created_at DESC LIMIT 3').all(id);

  const tickets_open = db.prepare("SELECT COUNT(*) as c FROM zendesk_tickets WHERE customer_id=? AND status NOT IN ('solved','closed','')").get(id).c;
  const tickets_total = db.prepare('SELECT COUNT(*) as c FROM zendesk_tickets WHERE customer_id=?').get(id).c;
  const recent_tickets = db.prepare('SELECT id, ticket_number, subject, status, priority FROM zendesk_tickets WHERE customer_id=? ORDER BY created_at DESC LIMIT 3').all(id);

  const meetings_count = db.prepare('SELECT COUNT(*) as c FROM meetings WHERE customer_id=?').get(id).c;
  const recent_meetings = db.prepare('SELECT id, title, meeting_date FROM meetings WHERE customer_id=? ORDER BY meeting_date DESC LIMIT 3').all(id);

  const actions_open = db.prepare("SELECT COUNT(*) as c FROM action_items WHERE customer_id=? AND status IN ('open','in_progress')").get(id).c;
  const actions_total = db.prepare('SELECT COUNT(*) as c FROM action_items WHERE customer_id=?').get(id).c;
  const recent_actions = db.prepare("SELECT id, title, status, due_date FROM action_items WHERE customer_id=? AND status != 'done' ORDER BY due_date ASC LIMIT 5").all(id);

  const latest_health = db.prepare('SELECT * FROM health_checks WHERE customer_id=? ORDER BY check_date DESC LIMIT 1').get(id);
  const health_count = db.prepare('SELECT COUNT(*) as c FROM health_checks WHERE customer_id=?').get(id).c;

  res.json({
    customer: c,
    notes: { count: notes_count, recent: recent_notes },
    tickets: { open: tickets_open, total: tickets_total, recent: recent_tickets },
    meetings: { count: meetings_count, recent: recent_meetings },
    actions: { open: actions_open, total: actions_total, recent: recent_actions },
    health: { latest: latest_health, count: health_count },
  });
});

app.post('/api/customers', (req, res) => {
  const { name, org, cre_role, slack_channel, ghes_version, contract_tier, avatar_color } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  const id = uuidv4();
  const slug = uniqueSlug(name);
  db.prepare(`INSERT INTO customers (id, slug, name, org, cre_role, slack_channel, ghes_version, contract_tier, avatar_color)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, slug, name.trim(), org || '', cre_role || 'primary', slack_channel || '', ghes_version || '', contract_tier || '', avatar_color || '#6366f1'
  );
  res.status(201).json(db.prepare('SELECT * FROM customers WHERE id = ?').get(id));
});

app.put('/api/customers/:id', (req, res) => {
  const { name, org, cre_role, slack_channel, ghes_version, contract_tier, avatar_color, notes_general } = req.body;
  const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const slug = name && name.trim() !== existing.name ? uniqueSlug(name, req.params.id) : existing.slug;
  db.prepare(`UPDATE customers SET name=?, org=?, slug=?, cre_role=?, slack_channel=?, ghes_version=?,
    contract_tier=?, avatar_color=?, notes_general=?, updated_at=? WHERE id=?`).run(
    (name || existing.name).trim(), org ?? existing.org, slug, cre_role || existing.cre_role,
    slack_channel ?? existing.slack_channel, ghes_version ?? existing.ghes_version,
    contract_tier ?? existing.contract_tier, avatar_color ?? existing.avatar_color,
    notes_general ?? existing.notes_general, now(), req.params.id
  );
  res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id));
});

app.delete('/api/customers/:id', (req, res) => {
  const result = db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Generic CRUD factory for sub-resources ──────────
function subResource(tableName, fields, opts = {}) {
  const router = express.Router({ mergeParams: true });

  router.get('/', (req, res) => {
    const order = opts.orderBy || 'created_at DESC';
    res.json(db.prepare(`SELECT * FROM ${tableName} WHERE customer_id=? ORDER BY ${order}`).all(req.params.customerId));
  });

  router.get('/:itemId', (req, res) => {
    const row = db.prepare(`SELECT * FROM ${tableName} WHERE id=? AND customer_id=?`).get(req.params.itemId, req.params.customerId);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  });

  router.post('/', (req, res) => {
    const id = uuidv4();
    const vals = { id, customer_id: req.params.customerId };
    for (const f of fields) vals[f] = req.body[f] ?? '';
    const cols = Object.keys(vals);
    const placeholders = cols.map(() => '?').join(',');
    db.prepare(`INSERT INTO ${tableName} (${cols.join(',')}) VALUES (${placeholders})`).run(...cols.map(c => vals[c]));
    res.status(201).json(db.prepare(`SELECT * FROM ${tableName} WHERE id=?`).get(id));
  });

  router.put('/:itemId', (req, res) => {
    const existing = db.prepare(`SELECT * FROM ${tableName} WHERE id=? AND customer_id=?`).get(req.params.itemId, req.params.customerId);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) { sets.push(`${f}=?`); params.push(req.body[f]); }
    }
    if (sets.length === 0) return res.json(existing);
    sets.push('updated_at=?'); params.push(now());
    params.push(req.params.itemId);
    db.prepare(`UPDATE ${tableName} SET ${sets.join(',')} WHERE id=?`).run(...params);
    res.json(db.prepare(`SELECT * FROM ${tableName} WHERE id=?`).get(req.params.itemId));
  });

  router.delete('/:itemId', (req, res) => {
    const result = db.prepare(`DELETE FROM ${tableName} WHERE id=? AND customer_id=?`).run(req.params.itemId, req.params.customerId);
    if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  return router;
}

app.use('/api/customers/:customerId/notes', subResource('notes', ['title', 'body', 'source', 'external_id']));
app.use('/api/customers/:customerId/tickets', subResource('zendesk_tickets',
  ['ticket_number', 'subject', 'status', 'priority', 'summary', 'requester', 'assigned_to', 'source', 'external_id', 'ticket_created_at', 'ticket_updated_at'],
  { orderBy: 'created_at DESC' }
));
app.use('/api/customers/:customerId/meetings', subResource('meetings',
  ['title', 'meeting_date', 'attendees', 'summary', 'action_items_text', 'source', 'external_id'],
  { orderBy: 'meeting_date DESC' }
));
app.use('/api/customers/:customerId/actions', subResource('action_items',
  ['title', 'description', 'status', 'owner', 'due_date', 'source', 'external_id'],
  { orderBy: "CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 WHEN 'blocked' THEN 2 WHEN 'done' THEN 3 END, due_date ASC" }
));
app.use('/api/customers/:customerId/health', subResource('health_checks',
  ['check_date', 'status', 'category', 'notes', 'next_check_due', 'source', 'external_id'],
  { orderBy: 'check_date DESC' }
));

// Action item status toggle (convenience)
app.patch('/api/customers/:customerId/actions/:itemId/toggle', (req, res) => {
  const item = db.prepare('SELECT * FROM action_items WHERE id=? AND customer_id=?').get(req.params.itemId, req.params.customerId);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const next = item.status === 'done' ? 'open' : 'done';
  db.prepare('UPDATE action_items SET status=?, updated_at=? WHERE id=?').run(next, now(), item.id);
  res.json(db.prepare('SELECT * FROM action_items WHERE id=?').get(item.id));
});

// ── Start ───────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Customer Dashboard running on http://localhost:${PORT}`);
});
