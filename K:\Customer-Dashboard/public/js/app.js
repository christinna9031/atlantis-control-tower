/* ── Customer Dashboard SPA ────────────────────────── */
(function () {
  'use strict';

  // ── State ─────────────────────────────────────────
  let customers = [];
  let activeCustomerId = null;
  let activeTab = 'overview';

  // ── DOM refs ──────────────────────────────────────
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

  const customerList = $('#customer-list');
  const customerSearch = $('#customer-search');
  const emptyState = $('#empty-state');
  const customerView = $('#customer-view');
  const tabContent = $('#tab-content');
  const modalOverlay = $('#modal-overlay');
  const modalTitle = $('#modal-title');
  const modalBody = $('#modal-body');
  const modalFooter = $('#modal-footer');

  // ── Safe text helper (prevents XSS) ───────────────
  function esc(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  function setText(el, text) { el.textContent = text ?? ''; }

  // ── API helpers ───────────────────────────────────
  async function api(path, opts = {}) {
    const res = await fetch(`/api${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Request failed');
    }
    return res.json();
  }

  // ── Modal helpers ─────────────────────────────────
  function openModal(title, bodyHtml, buttons = []) {
    setText(modalTitle, title);
    modalBody.innerHTML = bodyHtml;
    modalFooter.innerHTML = '';
    for (const btn of buttons) {
      const b = document.createElement('button');
      b.className = `btn ${btn.class || ''}`;
      setText(b, btn.label);
      b.onclick = btn.onclick;
      modalFooter.appendChild(b);
    }
    modalOverlay.classList.remove('hidden');
  }

  function closeModal() { modalOverlay.classList.add('hidden'); }
  $('#modal-close').onclick = closeModal;
  modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });

  // ── Customer List ─────────────────────────────────
  async function loadCustomers() {
    customers = await api('/customers');
    renderCustomerList();
  }

  function renderCustomerList(filter = '') {
    const q = filter.toLowerCase();
    const filtered = customers.filter(c =>
      c.name.toLowerCase().includes(q) || (c.org || '').toLowerCase().includes(q)
    );
    customerList.innerHTML = '';
    for (const c of filtered) {
      const li = document.createElement('li');
      if (c.id === activeCustomerId) li.classList.add('active');
      li.dataset.id = c.id;

      const healthClass = c.latest_health ? `dot-${c.latest_health}` : 'dot-unknown';
      const initials = c.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();

      li.innerHTML = `
        <div class="avatar-sm" style="background:${esc(c.avatar_color)}">${esc(initials)}</div>
        <div class="customer-list-info">
          <div class="customer-list-name">${esc(c.name)}</div>
          <div class="customer-list-org">${esc(c.org)}</div>
        </div>
        <div class="customer-list-badges">
          ${c.open_actions > 0 ? `<span class="badge badge-warning" title="Open actions">${c.open_actions}</span>` : ''}
          ${c.open_tickets > 0 ? `<span class="badge badge-danger" title="Open tickets">${c.open_tickets}</span>` : ''}
          <span class="dot ${healthClass}" title="Health: ${c.latest_health || 'unknown'}"></span>
        </div>`;

      li.onclick = () => selectCustomer(c.id);
      customerList.appendChild(li);
    }
  }

  customerSearch.addEventListener('input', () => renderCustomerList(customerSearch.value));

  // ── Select Customer ───────────────────────────────
  async function selectCustomer(id) {
    activeCustomerId = id;
    activeTab = 'overview';
    renderCustomerList(customerSearch.value);
    emptyState.classList.add('hidden');
    customerView.classList.remove('hidden');

    const c = customers.find(x => x.id === id);
    if (!c) return;

    const avatar = $('#customer-avatar');
    const initials = c.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
    avatar.style.background = c.avatar_color;
    setText(avatar, initials);

    setText($('#customer-name'), c.name);
    const orgBadge = $('#customer-org');
    const roleBadge = $('#customer-role');
    const ghesBadge = $('#customer-ghes');
    const tierBadge = $('#customer-tier');
    const slackBadge = $('#customer-slack');

    setText(orgBadge, c.org ? `🏢 ${c.org}` : '');
    roleBadge.className = `badge ${c.cre_role === 'primary' ? 'badge-primary' : 'badge-secondary'}`;
    setText(roleBadge, c.cre_role === 'primary' ? '⭐ Primary CRE' : '🔹 Secondary CRE');
    setText(ghesBadge, c.ghes_version ? `GHES ${c.ghes_version}` : '');
    setText(tierBadge, c.contract_tier ? `📋 ${c.contract_tier}` : '');
    setText(slackBadge, c.slack_channel ? `💬 ${c.slack_channel}` : '');

    // Set active tab
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'overview'));

    loadTab('overview');
  }

  // ── Tabs ──────────────────────────────────────────
  document.addEventListener('click', e => {
    if (e.target.classList.contains('tab')) {
      activeTab = e.target.dataset.tab;
      $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === activeTab));
      loadTab(activeTab);
    }
  });

  async function loadTab(tab) {
    if (!activeCustomerId) return;
    tabContent.innerHTML = '<div style="padding:20px;color:var(--text-muted)">Loading…</div>';

    try {
      switch (tab) {
        case 'overview': return await renderOverview();
        case 'notes': return await renderNotes();
        case 'tickets': return await renderTickets();
        case 'meetings': return await renderMeetings();
        case 'actions': return await renderActions();
        case 'health': return await renderHealth();
      }
    } catch (err) {
      tabContent.innerHTML = `<div class="empty-section"><p>Error loading data: ${esc(err.message)}</p></div>`;
    }
  }

  // ── Overview Tab ──────────────────────────────────
  async function renderOverview() {
    const data = await api(`/customers/${activeCustomerId}/overview`);
    const { notes, tickets, meetings, actions, health } = data;

    const healthStatus = health.latest?.status || 'unknown';
    const healthLabel = { healthy: '✅ Healthy', warning: '⚠️ Warning', critical: '🔴 Critical', unknown: '❔ Unknown' }[healthStatus];

    tabContent.innerHTML = `
      <div class="overview-grid">
        <div class="overview-card" data-goto="notes">
          <div class="ov-header"><span class="ov-title">📝 Notes</span></div>
          <div class="ov-stat">${notes.count}</div>
          <ul class="ov-list">${notes.recent.map(n => `<li>${esc(n.title || 'Untitled')} — <small>${formatDate(n.created_at)}</small></li>`).join('')}</ul>
        </div>
        <div class="overview-card" data-goto="tickets">
          <div class="ov-header"><span class="ov-title">🎫 Zendesk Tickets</span></div>
          <div class="ov-stat">${tickets.open} <span style="font-size:14px;color:var(--text-muted)">open / ${tickets.total} total</span></div>
          <ul class="ov-list">${tickets.recent.map(t => `<li><span class="badge badge-${priorityBadge(t.priority)}" style="font-size:10px">${esc(t.status)}</span> #${esc(t.ticket_number)} ${esc(t.subject)}</li>`).join('')}</ul>
        </div>
        <div class="overview-card" data-goto="meetings">
          <div class="ov-header"><span class="ov-title">📅 Meetings</span></div>
          <div class="ov-stat">${meetings.count}</div>
          <ul class="ov-list">${meetings.recent.map(m => `<li>${esc(m.title)} — <small>${formatDate(m.meeting_date)}</small></li>`).join('')}</ul>
        </div>
        <div class="overview-card" data-goto="actions">
          <div class="ov-header"><span class="ov-title">✅ Action Items</span></div>
          <div class="ov-stat">${actions.open} <span style="font-size:14px;color:var(--text-muted)">open / ${actions.total} total</span></div>
          <ul class="ov-list">${actions.recent.map(a => `<li><span class="badge badge-${statusBadge(a.status)}">${esc(a.status)}</span> ${esc(a.title)}${a.due_date ? ` — due ${formatDate(a.due_date)}` : ''}</li>`).join('')}</ul>
        </div>
        <div class="overview-card" data-goto="health">
          <div class="ov-header"><span class="ov-title">💊 Health Checks</span></div>
          <div class="ov-stat"><span class="health-indicator health-${healthStatus}">${healthLabel}</span></div>
          <div class="ov-detail">${health.count} checks recorded${health.latest?.next_check_due ? ` · Next: ${formatDate(health.latest.next_check_due)}` : ''}</div>
        </div>
      </div>`;

    // Click to navigate to tab
    $$('.overview-card[data-goto]', tabContent).forEach(card => {
      card.onclick = () => {
        const tab = card.dataset.goto;
        $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
        activeTab = tab;
        loadTab(tab);
      };
    });
  }

  // ── Notes Tab ─────────────────────────────────────
  async function renderNotes() {
    const items = await api(`/customers/${activeCustomerId}/notes`);
    tabContent.innerHTML = `
      <div class="section-header">
        <h3>📝 Notes <span class="section-count">${items.length}</span></h3>
        <button class="btn btn-primary btn-sm" id="btn-add-note">＋ Add Note</button>
      </div>
      ${items.length === 0 ? emptySection('📝', 'No notes yet') : ''}
      <ul class="item-list">${items.map(n => `
        <li class="item" data-id="${n.id}">
          <div class="item-main">
            <div class="item-title">${esc(n.title || 'Untitled')}</div>
            <div class="item-meta"><span>${formatDate(n.created_at)}</span>${n.source !== 'manual' ? `<span class="badge">${esc(n.source)}</span>` : ''}</div>
            <div class="item-body">${esc(n.body)}</div>
          </div>
          <div class="item-actions">
            <button class="btn btn-ghost btn-sm btn-edit-item" data-type="note" data-id="${n.id}">✏️</button>
            <button class="btn btn-ghost btn-sm btn-delete-item" data-type="notes" data-id="${n.id}">🗑️</button>
          </div>
        </li>`).join('')}</ul>`;

    $('#btn-add-note', tabContent).onclick = () => showNoteModal();
  }

  function showNoteModal(note = null) {
    const isEdit = !!note;
    openModal(isEdit ? 'Edit Note' : 'Add Note', `
      <div class="form-group"><label>Title</label><input id="f-title" value="${esc(note?.title || '')}"></div>
      <div class="form-group"><label>Body</label><textarea id="f-body" rows="6">${esc(note?.body || '')}</textarea></div>
    `, [
      { label: 'Cancel', class: '', onclick: closeModal },
      { label: isEdit ? 'Save' : 'Add', class: 'btn-primary', onclick: async () => {
        const body = { title: $('#f-title').value, body: $('#f-body').value };
        if (isEdit) await api(`/customers/${activeCustomerId}/notes/${note.id}`, { method: 'PUT', body });
        else await api(`/customers/${activeCustomerId}/notes`, { method: 'POST', body });
        closeModal(); loadTab('notes'); loadCustomers();
      }},
    ]);
  }

  // ── Tickets Tab ───────────────────────────────────
  async function renderTickets() {
    const items = await api(`/customers/${activeCustomerId}/tickets`);
    tabContent.innerHTML = `
      <div class="section-header">
        <h3>🎫 Zendesk Tickets <span class="section-count">${items.length}</span></h3>
        <button class="btn btn-primary btn-sm" id="btn-add-ticket">＋ Add Ticket</button>
      </div>
      ${items.length === 0 ? emptySection('🎫', 'No tickets tracked yet') : ''}
      <ul class="item-list">${items.map(t => `
        <li class="item" data-id="${t.id}">
          <div class="item-main">
            <div class="item-title">
              ${t.ticket_number ? `<span style="color:var(--text-muted)">#${esc(t.ticket_number)}</span> ` : ''}${esc(t.subject)}
            </div>
            <div class="item-meta">
              <span class="badge badge-${statusToBadge(t.status)}">${esc(t.status || 'unknown')}</span>
              ${t.priority ? `<span class="badge badge-${priorityBadge(t.priority)}">${esc(t.priority)}</span>` : ''}
              ${t.requester ? `<span>👤 ${esc(t.requester)}</span>` : ''}
              ${t.assigned_to ? `<span>→ ${esc(t.assigned_to)}</span>` : ''}
              <span>${formatDate(t.ticket_created_at || t.created_at)}</span>
            </div>
            ${t.summary ? `<div class="item-body">${esc(t.summary)}</div>` : ''}
          </div>
          <div class="item-actions">
            <button class="btn btn-ghost btn-sm btn-edit-item" data-type="ticket" data-id="${t.id}">✏️</button>
            <button class="btn btn-ghost btn-sm btn-delete-item" data-type="tickets" data-id="${t.id}">🗑️</button>
          </div>
        </li>`).join('')}</ul>`;

    $('#btn-add-ticket', tabContent).onclick = () => showTicketModal();
  }

  function showTicketModal(ticket = null) {
    const t = ticket || {};
    const isEdit = !!ticket;
    openModal(isEdit ? 'Edit Ticket' : 'Add Ticket Summary', `
      <div class="form-row">
        <div class="form-group"><label>Ticket #</label><input id="f-ticket-number" value="${esc(t.ticket_number || '')}"></div>
        <div class="form-group"><label>Status</label>
          <select id="f-status">
            ${['new','open','pending','hold','solved','closed'].map(s => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-group"><label>Subject</label><input id="f-subject" value="${esc(t.subject || '')}"></div>
      <div class="form-row">
        <div class="form-group"><label>Priority</label>
          <select id="f-priority">
            ${['low','normal','high','urgent'].map(p => `<option value="${p}" ${t.priority === p ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
        </div>
        <div class="form-group"><label>Requester</label><input id="f-requester" value="${esc(t.requester || '')}"></div>
      </div>
      <div class="form-group"><label>Assigned To</label><input id="f-assigned" value="${esc(t.assigned_to || '')}"></div>
      <div class="form-group"><label>Summary</label><textarea id="f-summary" rows="5">${esc(t.summary || '')}</textarea></div>
    `, [
      { label: 'Cancel', onclick: closeModal },
      { label: isEdit ? 'Save' : 'Add', class: 'btn-primary', onclick: async () => {
        const body = {
          ticket_number: $('#f-ticket-number').value, status: $('#f-status').value,
          subject: $('#f-subject').value, priority: $('#f-priority').value,
          requester: $('#f-requester').value, assigned_to: $('#f-assigned').value,
          summary: $('#f-summary').value,
        };
        if (isEdit) await api(`/customers/${activeCustomerId}/tickets/${ticket.id}`, { method: 'PUT', body });
        else await api(`/customers/${activeCustomerId}/tickets`, { method: 'POST', body });
        closeModal(); loadTab('tickets'); loadCustomers();
      }},
    ]);
  }

  // ── Meetings Tab ──────────────────────────────────
  async function renderMeetings() {
    const items = await api(`/customers/${activeCustomerId}/meetings`);
    tabContent.innerHTML = `
      <div class="section-header">
        <h3>📅 Meetings <span class="section-count">${items.length}</span></h3>
        <button class="btn btn-primary btn-sm" id="btn-add-meeting">＋ Add Meeting</button>
      </div>
      ${items.length === 0 ? emptySection('📅', 'No meetings recorded yet') : ''}
      <ul class="item-list">${items.map(m => `
        <li class="item" data-id="${m.id}">
          <div class="item-main">
            <div class="item-title">${esc(m.title || 'Untitled Meeting')}</div>
            <div class="item-meta">
              <span>📅 ${formatDate(m.meeting_date)}</span>
              ${m.attendees ? `<span>👥 ${esc(m.attendees)}</span>` : ''}
            </div>
            ${m.summary ? `<div class="item-body">${esc(m.summary)}</div>` : ''}
            ${m.action_items_text ? `<div class="item-body" style="margin-top:8px;padding:8px;background:var(--bg-tertiary);border-radius:var(--radius-sm)"><strong style="color:var(--accent)">Action Items:</strong>\n${esc(m.action_items_text)}</div>` : ''}
          </div>
          <div class="item-actions">
            <button class="btn btn-ghost btn-sm btn-edit-item" data-type="meeting" data-id="${m.id}">✏️</button>
            <button class="btn btn-ghost btn-sm btn-delete-item" data-type="meetings" data-id="${m.id}">🗑️</button>
          </div>
        </li>`).join('')}</ul>`;

    $('#btn-add-meeting', tabContent).onclick = () => showMeetingModal();
  }

  function showMeetingModal(meeting = null) {
    const m = meeting || {};
    const isEdit = !!meeting;
    openModal(isEdit ? 'Edit Meeting' : 'Add Meeting', `
      <div class="form-group"><label>Title</label><input id="f-title" value="${esc(m.title || '')}"></div>
      <div class="form-row">
        <div class="form-group"><label>Date</label><input type="date" id="f-date" value="${esc(m.meeting_date || new Date().toISOString().slice(0, 10))}"></div>
        <div class="form-group"><label>Attendees</label><input id="f-attendees" value="${esc(m.attendees || '')}" placeholder="Comma-separated names"></div>
      </div>
      <div class="form-group"><label>Summary</label><textarea id="f-summary" rows="5">${esc(m.summary || '')}</textarea></div>
      <div class="form-group"><label>Action Items</label><textarea id="f-actions-text" rows="3" placeholder="One per line">${esc(m.action_items_text || '')}</textarea></div>
    `, [
      { label: 'Cancel', onclick: closeModal },
      { label: isEdit ? 'Save' : 'Add', class: 'btn-primary', onclick: async () => {
        const body = {
          title: $('#f-title').value, meeting_date: $('#f-date').value,
          attendees: $('#f-attendees').value, summary: $('#f-summary').value,
          action_items_text: $('#f-actions-text').value,
        };
        if (isEdit) await api(`/customers/${activeCustomerId}/meetings/${meeting.id}`, { method: 'PUT', body });
        else await api(`/customers/${activeCustomerId}/meetings`, { method: 'POST', body });
        closeModal(); loadTab('meetings'); loadCustomers();
      }},
    ]);
  }

  // ── Action Items Tab ──────────────────────────────
  async function renderActions() {
    const items = await api(`/customers/${activeCustomerId}/actions`);
    const open = items.filter(a => a.status !== 'done');
    const done = items.filter(a => a.status === 'done');

    tabContent.innerHTML = `
      <div class="section-header">
        <h3>✅ Action Items <span class="section-count">${open.length} open / ${items.length} total</span></h3>
        <button class="btn btn-primary btn-sm" id="btn-add-action">＋ Add Action</button>
      </div>
      ${items.length === 0 ? emptySection('✅', 'No action items yet') : ''}
      <ul class="item-list">${open.map(a => actionItemHtml(a)).join('')}</ul>
      ${done.length > 0 ? `
        <details style="margin-top:16px">
          <summary style="cursor:pointer;color:var(--text-muted);font-size:13px;margin-bottom:8px">Completed (${done.length})</summary>
          <ul class="item-list">${done.map(a => actionItemHtml(a)).join('')}</ul>
        </details>` : ''}`;

    $('#btn-add-action', tabContent).onclick = () => showActionModal();

    // Toggle handlers
    $$('.action-toggle', tabContent).forEach(btn => {
      btn.onclick = async () => {
        await api(`/customers/${activeCustomerId}/actions/${btn.dataset.id}/toggle`, { method: 'PATCH' });
        loadTab('actions'); loadCustomers();
      };
    });

    // Status change handlers
    $$('.action-status-select', tabContent).forEach(sel => {
      sel.onchange = async () => {
        await api(`/customers/${activeCustomerId}/actions/${sel.dataset.id}`, { method: 'PUT', body: { status: sel.value } });
        loadTab('actions'); loadCustomers();
      };
    });
  }

  function actionItemHtml(a) {
    const checkClass = a.status === 'done' ? 'checked' : a.status === 'in_progress' ? 'in-progress' : a.status === 'blocked' ? 'blocked' : '';
    const checkIcon = a.status === 'done' ? '✓' : a.status === 'in_progress' ? '◐' : a.status === 'blocked' ? '✕' : '';
    return `
      <li class="item ${a.status === 'done' ? 'done' : ''}" data-id="${a.id}">
        <button class="action-check ${checkClass} action-toggle" data-id="${a.id}" title="Toggle done">${checkIcon}</button>
        <div class="item-main">
          <div class="item-title">${esc(a.title)}</div>
          <div class="item-meta">
            <select class="status-select action-status-select" data-id="${a.id}">
              ${['open','in_progress','done','blocked'].map(s => `<option value="${s}" ${a.status === s ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}
            </select>
            ${a.owner ? `<span>👤 ${esc(a.owner)}</span>` : ''}
            ${a.due_date ? `<span>📅 ${formatDate(a.due_date)}</span>` : ''}
          </div>
          ${a.description ? `<div class="item-body">${esc(a.description)}</div>` : ''}
        </div>
        <div class="item-actions">
          <button class="btn btn-ghost btn-sm btn-edit-item" data-type="action" data-id="${a.id}">✏️</button>
          <button class="btn btn-ghost btn-sm btn-delete-item" data-type="actions" data-id="${a.id}">🗑️</button>
        </div>
      </li>`;
  }

  function showActionModal(action = null) {
    const a = action || {};
    const isEdit = !!action;
    openModal(isEdit ? 'Edit Action Item' : 'Add Action Item', `
      <div class="form-group"><label>Title</label><input id="f-title" value="${esc(a.title || '')}"></div>
      <div class="form-group"><label>Description</label><textarea id="f-desc" rows="3">${esc(a.description || '')}</textarea></div>
      <div class="form-row">
        <div class="form-group"><label>Status</label>
          <select id="f-status">
            ${['open','in_progress','done','blocked'].map(s => `<option value="${s}" ${a.status === s ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}
          </select>
        </div>
        <div class="form-group"><label>Owner</label><input id="f-owner" value="${esc(a.owner || '')}"></div>
      </div>
      <div class="form-group"><label>Due Date</label><input type="date" id="f-due" value="${esc(a.due_date || '')}"></div>
    `, [
      { label: 'Cancel', onclick: closeModal },
      { label: isEdit ? 'Save' : 'Add', class: 'btn-primary', onclick: async () => {
        const body = {
          title: $('#f-title').value, description: $('#f-desc').value,
          status: $('#f-status').value, owner: $('#f-owner').value, due_date: $('#f-due').value,
        };
        if (isEdit) await api(`/customers/${activeCustomerId}/actions/${action.id}`, { method: 'PUT', body });
        else await api(`/customers/${activeCustomerId}/actions`, { method: 'POST', body });
        closeModal(); loadTab('actions'); loadCustomers();
      }},
    ]);
  }

  // ── Health Checks Tab ─────────────────────────────
  async function renderHealth() {
    const items = await api(`/customers/${activeCustomerId}/health`);
    tabContent.innerHTML = `
      <div class="section-header">
        <h3>💊 Health Checks <span class="section-count">${items.length}</span></h3>
        <button class="btn btn-primary btn-sm" id="btn-add-health">＋ Add Check</button>
      </div>
      ${items.length === 0 ? emptySection('💊', 'No health checks recorded yet') : ''}
      <ul class="item-list">${items.map(h => `
        <li class="item" data-id="${h.id}">
          <div class="item-main">
            <div class="item-title">
              <span class="health-indicator health-${h.status}">${healthIcon(h.status)} ${esc(h.status)}</span>
              <span style="margin-left:8px;color:var(--text-secondary)">${esc(h.category)}</span>
            </div>
            <div class="item-meta">
              <span>📅 ${formatDate(h.check_date)}</span>
              ${h.next_check_due ? `<span>Next: ${formatDate(h.next_check_due)}</span>` : ''}
            </div>
            ${h.notes ? `<div class="item-body">${esc(h.notes)}</div>` : ''}
          </div>
          <div class="item-actions">
            <button class="btn btn-ghost btn-sm btn-edit-item" data-type="health-check" data-id="${h.id}">✏️</button>
            <button class="btn btn-ghost btn-sm btn-delete-item" data-type="health" data-id="${h.id}">🗑️</button>
          </div>
        </li>`).join('')}</ul>`;

    $('#btn-add-health', tabContent).onclick = () => showHealthModal();
  }

  function showHealthModal(check = null) {
    const h = check || {};
    const isEdit = !!check;
    openModal(isEdit ? 'Edit Health Check' : 'Add Health Check', `
      <div class="form-row">
        <div class="form-group"><label>Date</label><input type="date" id="f-date" value="${esc(h.check_date || new Date().toISOString().slice(0, 10))}"></div>
        <div class="form-group"><label>Status</label>
          <select id="f-status">
            ${['healthy','warning','critical','unknown'].map(s => `<option value="${s}" ${h.status === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Category</label><input id="f-category" value="${esc(h.category || 'general')}" placeholder="e.g., general, performance, security"></div>
        <div class="form-group"><label>Next Check Due</label><input type="date" id="f-next" value="${esc(h.next_check_due || '')}"></div>
      </div>
      <div class="form-group"><label>Notes</label><textarea id="f-notes" rows="4">${esc(h.notes || '')}</textarea></div>
    `, [
      { label: 'Cancel', onclick: closeModal },
      { label: isEdit ? 'Save' : 'Add', class: 'btn-primary', onclick: async () => {
        const body = {
          check_date: $('#f-date').value, status: $('#f-status').value,
          category: $('#f-category').value, next_check_due: $('#f-next').value,
          notes: $('#f-notes').value,
        };
        if (isEdit) await api(`/customers/${activeCustomerId}/health/${check.id}`, { method: 'PUT', body });
        else await api(`/customers/${activeCustomerId}/health`, { method: 'POST', body });
        closeModal(); loadTab('health'); loadCustomers();
      }},
    ]);
  }

  // ── Customer CRUD (Add/Edit/Delete) ───────────────
  $('#btn-add-customer').onclick = () => showCustomerModal();
  $('#btn-edit-customer').onclick = () => {
    const c = customers.find(x => x.id === activeCustomerId);
    if (c) showCustomerModal(c);
  };
  $('#btn-delete-customer').onclick = () => {
    if (!activeCustomerId) return;
    const c = customers.find(x => x.id === activeCustomerId);
    openModal('Delete Customer', `<p>Are you sure you want to delete <strong>${esc(c?.name)}</strong> and all associated data?</p>`, [
      { label: 'Cancel', onclick: closeModal },
      { label: 'Delete', class: 'btn-danger', onclick: async () => {
        await api(`/customers/${activeCustomerId}`, { method: 'DELETE' });
        activeCustomerId = null;
        closeModal();
        customerView.classList.add('hidden');
        emptyState.classList.remove('hidden');
        loadCustomers();
      }},
    ]);
  };

  const COLORS = ['#6366f1','#ec4899','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ef4444','#14b8a6','#f97316','#06b6d4'];

  function showCustomerModal(customer = null) {
    const c = customer || {};
    const isEdit = !!customer;
    openModal(isEdit ? 'Edit Customer' : 'Add Customer', `
      <div class="form-group"><label>Name *</label><input id="f-name" value="${esc(c.name || '')}" placeholder="Customer name"></div>
      <div class="form-row">
        <div class="form-group"><label>Organization</label><input id="f-org" value="${esc(c.org || '')}"></div>
        <div class="form-group"><label>CRE Role</label>
          <select id="f-role"><option value="primary" ${c.cre_role !== 'secondary' ? 'selected' : ''}>Primary</option><option value="secondary" ${c.cre_role === 'secondary' ? 'selected' : ''}>Secondary</option></select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Slack Channel</label><input id="f-slack" value="${esc(c.slack_channel || '')}" placeholder="#customer-channel"></div>
        <div class="form-group"><label>GHES Version</label><input id="f-ghes" value="${esc(c.ghes_version || '')}" placeholder="3.12"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Contract Tier</label><input id="f-tier" value="${esc(c.contract_tier || '')}" placeholder="Premium, Enterprise…"></div>
        <div class="form-group"><label>Avatar Color</label>
          <div style="display:flex;gap:6px;margin-top:4px">${COLORS.map(clr => `<div class="color-pick" data-color="${clr}" style="width:24px;height:24px;border-radius:50%;background:${clr};cursor:pointer;border:2px solid ${c.avatar_color === clr || (!c.avatar_color && clr === '#6366f1') ? 'white' : 'transparent'}"></div>`).join('')}</div>
        </div>
      </div>
    `, [
      { label: 'Cancel', onclick: closeModal },
      { label: isEdit ? 'Save' : 'Create', class: 'btn-primary', onclick: async () => {
        const name = $('#f-name').value.trim();
        if (!name) return alert('Name is required');
        const body = {
          name, org: $('#f-org').value, cre_role: $('#f-role').value,
          slack_channel: $('#f-slack').value, ghes_version: $('#f-ghes').value,
          contract_tier: $('#f-tier').value,
          avatar_color: modalBody.querySelector('.color-pick[style*="border: 2px solid white"], .color-pick[style*="border:2px solid white"]')?.dataset.color
            || modalBody._selectedColor || c.avatar_color || '#6366f1',
        };
        if (isEdit) {
          await api(`/customers/${customer.id}`, { method: 'PUT', body });
        } else {
          const created = await api('/customers', { method: 'POST', body });
          activeCustomerId = created.id;
        }
        closeModal(); await loadCustomers();
        if (activeCustomerId) selectCustomer(activeCustomerId);
      }},
    ]);

    // Color picker interaction
    $$('.color-pick', modalBody).forEach(el => {
      el.onclick = () => {
        $$('.color-pick', modalBody).forEach(e => e.style.border = '2px solid transparent');
        el.style.border = '2px solid white';
        modalBody._selectedColor = el.dataset.color;
      };
    });
  }

  // ── Delegated edit/delete for items ───────────────
  document.addEventListener('click', async (e) => {
    const editBtn = e.target.closest('.btn-edit-item');
    if (editBtn) {
      const { type, id } = editBtn.dataset;
      const typeMap = { note: 'notes', ticket: 'tickets', meeting: 'meetings', action: 'actions', 'health-check': 'health' };
      const endpoint = typeMap[type] || type;
      const item = await api(`/customers/${activeCustomerId}/${endpoint}/${id}`);
      switch (type) {
        case 'note': return showNoteModal(item);
        case 'ticket': return showTicketModal(item);
        case 'meeting': return showMeetingModal(item);
        case 'action': return showActionModal(item);
        case 'health-check': return showHealthModal(item);
      }
    }

    const delBtn = e.target.closest('.btn-delete-item');
    if (delBtn) {
      const { type, id } = delBtn.dataset;
      if (!confirm('Delete this item?')) return;
      await api(`/customers/${activeCustomerId}/${type}/${id}`, { method: 'DELETE' });
      loadTab(activeTab); loadCustomers();
    }
  });

  // ── Helpers ───────────────────────────────────────
  function formatDate(d) {
    if (!d) return '—';
    try {
      const date = new Date(d.includes('T') || d.includes(' ') ? d : d + 'T00:00:00');
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch { return d; }
  }

  function emptySection(icon, text) {
    return `<div class="empty-section"><div class="empty-section-icon">${icon}</div><p>${esc(text)}</p></div>`;
  }

  function healthIcon(status) {
    return { healthy: '✅', warning: '⚠️', critical: '🔴', unknown: '❔' }[status] || '❔';
  }

  function priorityBadge(p) {
    return { urgent: 'danger', high: 'danger', normal: 'warning', low: '' }[p] || '';
  }

  function statusBadge(s) {
    return { open: 'warning', in_progress: 'primary', done: 'success', blocked: 'danger' }[s] || '';
  }

  function statusToBadge(s) {
    return { new: 'primary', open: 'primary', pending: 'warning', hold: 'warning', solved: 'success', closed: 'success' }[s] || '';
  }

  // ── Init ──────────────────────────────────────────
  loadCustomers();
})();
