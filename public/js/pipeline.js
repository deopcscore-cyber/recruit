/* ============================================================
   Welltower Recruiter — Pipeline, Cards, 7-Tab Candidate Modal
   ============================================================ */

// Client-side markdown → HTML for JD preview pane
function markdownToHtmlPreview(text) {
  if (!text) return '';
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const inline = s => s
    .replace(/\*\*\*(.+?)\*\*\*/g,'<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,'<em>$1</em>')
    .replace(/_{1,2}([^_]+)_{1,2}/g,'<em>$1</em>');
  const lines = text.split('\n');
  const out = [];
  let inUl = false, inOl = false;
  const closeList = () => {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  };
  for (const raw of lines) {
    const line = raw;
    const h3 = line.match(/^###\s+(.+)$/), h2 = line.match(/^##\s+(.+)$/), h1 = line.match(/^#\s+(.+)$/);
    if (h1||h2||h3) { closeList(); const lv=h1?1:h2?2:3; const t=(h1||h2||h3)[1]; out.push(`<h${lv} style="margin:18px 0 4px;color:#1a1a2e">${inline(esc(t))}</h${lv}>`); continue; }
    if (line.match(/^[-*_]{3,}\s*$/)) { closeList(); out.push('<hr style="border:none;border-top:1px solid #dde3f0;margin:14px 0">'); continue; }
    const b = line.match(/^[-*]\s+(.+)$/);
    if (b) { if (!inUl) { out.push('<ul style="padding-left:20px;margin:4px 0">'); inUl=true; } out.push(`<li>${inline(esc(b[1]))}</li>`); continue; }
    const n = line.match(/^\d+\.\s+(.+)$/);
    if (n) { if (!inOl) { out.push('<ol style="padding-left:20px;margin:4px 0">'); inOl=true; } out.push(`<li>${inline(esc(n[1]))}</li>`); continue; }
    if (line.trim()==='') { closeList(); out.push('<br>'); continue; }
    const it = line.match(/^\*(.+)\*$/);
    if (it) { closeList(); out.push(`<p style="color:#777;font-style:italic;font-size:13px;margin:4px 0">${inline(esc(it[1]))}</p>`); continue; }
    closeList();
    out.push(`<p style="margin:4px 0;line-height:1.6">${inline(esc(line))}</p>`);
  }
  closeList();
  return out.join('');
}

const STAGES = [
  'Imported',
  'Outreach Sent',
  'Replied',
  'Resume Requested',
  'Resume Received',
  'Interviewing',
  'Closed'
];

const STAGE_COLORS = {
  'Imported': '#64748b',
  'Outreach Sent': '#2563eb',
  'Replied': '#7c3aed',
  'Resume Requested': '#d97706',
  'Resume Received': '#0891b2',
  'Interviewing': '#16a34a',
  'Closed': '#374151'
};

const TABS = [
  { key: 'profile',   label: 'Profile',    step: null },
  { key: 'outreach',  label: 'Outreach',   step: 'outreach' },
  { key: 'role-jd',   label: 'Role & JD',  step: 'roleJD' },
  { key: 'resume',    label: 'Resume',      step: 'resumeReceived' },
  { key: 'review',    label: 'Review',      step: 'reviewSent' },
  { key: 'victory',   label: 'Victory',     step: 'victorySent' },
  { key: 'thread',    label: 'Thread',      step: null }
];

// ---- Utilities ----

function initials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

function avatarColor(name) {
  const colors = ['#0f2c5c','#1a5fb4','#16a34a','#7c3aed','#d97706','#0891b2','#dc2626'];
  let h = 0;
  for (let i = 0; i < (name||'').length; i++) h = (h * 31 + name.charCodeAt(i)) % colors.length;
  return colors[h];
}

function formatDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatRelative(isoStr) {
  if (!isoStr) return '';
  const now = new Date();
  const d = new Date(isoStr);
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) {
    const hh = d.getHours() % 12 || 12;
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ampm = d.getHours() < 12 ? 'AM' : 'PM';
    const today = new Date(); today.setHours(0,0,0,0);
    if (d >= today) return `Today ${hh}:${mm} ${ampm}`;
  }
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1); yesterday.setHours(0,0,0,0);
  const dayStart = new Date(d); dayStart.setHours(0,0,0,0);
  if (dayStart.getTime() === yesterday.getTime()) return 'Yesterday';
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function stripHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || '';
}

function preview55(text) {
  if (!text) return '';
  const clean = stripHtml(text).replace(/\s+/g, ' ').trim();
  return clean.length > 55 ? clean.substring(0, 55) + '…' : clean;
}

function stageBadge(stage) {
  const color = STAGE_COLORS[stage] || '#64748b';
  return `<span class="stage-badge" style="background:${color}20;color:${color};border-color:${color}40">${stage || 'Imported'}</span>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ---- Metrics Bar ----

function renderMetricsBar(candidates) {
  const bar = document.getElementById('metrics-bar');
  if (!bar) return;
  bar.innerHTML = STAGES.map(s => {
    const count = candidates.filter(c => (c.stage || 'Imported') === s).length;
    const color = STAGE_COLORS[s];
    return `<div class="metric-pill" style="border-color:${color}40;background:${color}12" title="${s}">
      <span class="metric-count" style="color:${color}">${count}</span>
      <span class="metric-label">${s}</span>
    </div>`;
  }).join('');
}

// ---- Pipeline Board ----

function renderPipelineBoard(candidates, onCardClick) {
  const board = document.getElementById('pipeline-board');
  if (!board) return;
  board.innerHTML = '';

  STAGES.forEach(stage => {
    const stageCandidates = candidates.filter(c => (c.stage || 'Imported') === stage);
    const col = document.createElement('div');
    col.className = 'pipeline-column';
    col.dataset.stage = stage;
    const color = STAGE_COLORS[stage];

    col.innerHTML = `
      <div class="column-header" style="border-top:3px solid ${color}">
        <span class="column-title">${stage}</span>
        <span class="column-count" style="background:${color}20;color:${color}">${stageCandidates.length}</span>
      </div>
      <div class="column-cards" id="col-${stage.replace(/\s+/g,'-')}"></div>
    `;
    board.appendChild(col);

    const cardsEl = col.querySelector('.column-cards');
    if (stageCandidates.length === 0) {
      cardsEl.innerHTML = `<div class="col-empty">No candidates</div>`;
    } else {
      stageCandidates.sort((a,b) => new Date(b.updatedAt||0) - new Date(a.updatedAt||0)).forEach(c => {
        const card = createCandidateCard(c);
        card.addEventListener('click', () => onCardClick(c));
        cardsEl.appendChild(card);
      });
    }
  });
}

function createCandidateCard(candidate) {
  const card = document.createElement('div');
  card.className = 'candidate-card' + (candidate.unread ? ' unread' : '');
  card.dataset.id = candidate.id;

  // Last message
  const lastMsg = candidate.thread && candidate.thread.length > 0
    ? candidate.thread[candidate.thread.length - 1]
    : null;
  const lastActivity = lastMsg ? lastMsg.timestamp : candidate.updatedAt;
  const previewText = lastMsg ? preview55(lastMsg.body) : (candidate.summary ? preview55(candidate.summary) : '');

  // Follow-up badge
  let fuHtml = '';
  if (candidate.followUpDate) {
    const now = new Date();
    const diff = Math.floor((new Date(candidate.followUpDate) - now) / 86400000);
    if (diff <= 0 && !candidate.unread) {
      fuHtml = `<div class="followup-prompt">Follow up?</div>`;
    }
  }

  const tags = (candidate.tags || []).slice(0, 2).map(t => `<span class="card-tag">${escapeHtml(t)}</span>`).join('');

  // Score badge
  let scoreBadge = '';
  if (candidate.score != null) {
    const sc = candidate.score;
    const scColor = sc >= 8 ? '#16a34a' : sc >= 5 ? '#d97706' : '#ef4444';
    scoreBadge = `<span style="font-size:0.7rem;font-weight:700;color:${scColor};border:1px solid ${scColor}40;border-radius:4px;padding:1px 5px;margin-left:4px">${sc}/10</span>`;
  }

  card.innerHTML = `
    <div class="card-top">
      <div class="card-name-row">
        <span class="card-name">${escapeHtml(candidate.name || 'Unknown')}${scoreBadge}</span>
        <div class="card-badges">
          ${candidate.unread ? '<span class="badge-new">New</span>' : ''}
          ${candidate.opened ? '<span class="badge-opened" title="Email opened">Opened</span>' : ''}
        </div>
      </div>
      <div class="card-meta">${escapeHtml(candidate.title || '')}${candidate.title && candidate.company ? ' · ' : ''}${escapeHtml(candidate.company || '')}</div>
    </div>
    ${previewText ? `<div class="card-preview">${escapeHtml(previewText)}</div>` : ''}
    <div class="card-bottom">
      <span class="card-time">${formatRelative(lastActivity)}</span>
      ${tags ? `<div class="card-tags">${tags}</div>` : ''}
    </div>
    ${fuHtml}
  `;

  return card;
}

// ---- List View ----

function renderListView(candidates, onRowClick) {
  const wrapper = document.getElementById('list-view');
  if (!wrapper) return;

  if (candidates.length === 0) {
    wrapper.innerHTML = `<div class="empty-state"><div class="empty-icon">👤</div><h3>No candidates yet</h3><p>Import a CSV or add candidates manually to get started.</p></div>`;
    return;
  }

  wrapper.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'candidates-table';
  table.innerHTML = `
    <thead><tr>
      <th><input type="checkbox" id="select-all-cb" /></th>
      <th>Name</th>
      <th>Title / Company</th>
      <th>Stage</th>
      <th>Last Activity</th>
      <th>Follow Up</th>
      <th></th>
    </tr></thead>
    <tbody id="list-tbody"></tbody>
  `;
  wrapper.appendChild(table);
  const tbody = table.querySelector('#list-tbody');

  candidates.sort((a,b) => new Date(b.updatedAt||0) - new Date(a.updatedAt||0)).forEach(c => {
    const tr = document.createElement('tr');
    tr.className = c.unread ? 'unread' : '';
    tr.dataset.id = c.id;

    let fuHtml = '';
    if (c.followUpDate) {
      const diff = Math.floor((new Date(c.followUpDate) - new Date()) / 86400000);
      fuHtml = diff < 0 ? `<span class="followup-badge overdue">Overdue</span>`
             : diff === 0 ? `<span class="followup-badge today">Today</span>`
             : `<span class="followup-badge upcoming">${diff}d</span>`;
    }

    tr.innerHTML = `
      <td><input type="checkbox" class="row-cb" data-id="${c.id}" /></td>
      <td>
        <div style="display:flex;align-items:center;gap:6px">
          <div class="list-avatar" style="background:${avatarColor(c.name)}">${initials(c.name)}</div>
          <div>
            <div class="font-medium">${escapeHtml(c.name||'Unknown')} ${c.unread?'<span class="badge-new">New</span>':''} ${c.opened?'<span class="badge-opened">Opened</span>':''}</div>
            <div class="text-xs text-muted">${escapeHtml(c.email||'')}</div>
          </div>
        </div>
      </td>
      <td><div class="text-sm">${escapeHtml(c.title||'')}</div><div class="text-xs text-muted">${escapeHtml(c.company||'')}</div></td>
      <td>${stageBadge(c.stage)}</td>
      <td class="text-sm text-muted">${formatRelative(c.updatedAt)}</td>
      <td>${fuHtml}</td>
      <td><button class="btn btn-ghost btn-sm open-btn" data-id="${c.id}">Open →</button></td>
    `;

    tr.addEventListener('click', e => {
      if (e.target.type === 'checkbox' || e.target.classList.contains('open-btn')) return;
      onRowClick(c);
    });
    tr.querySelector('.open-btn').addEventListener('click', () => onRowClick(c));
    tbody.appendChild(tr);
  });

  table.querySelector('#select-all-cb').addEventListener('change', e => {
    table.querySelectorAll('.row-cb').forEach(cb => { cb.checked = e.target.checked; });
  });
}

// ================================================================
// CANDIDATE MODAL — 7 TABS
// ================================================================

let _modalCandidate = null;
let _modalUser = null;
let _modalOnUpdate = null;
let _modalOnDelete = null;
let _activeTab = 'profile';

function openCandidateModal(candidate, user, onUpdate, onDelete) {
  _modalCandidate = candidate;
  _modalUser = user;
  _modalOnUpdate = onUpdate;
  _modalOnDelete = onDelete;
  _activeTab = 'profile';

  let overlay = document.getElementById('cmodal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'cmodal-overlay';
    overlay.className = 'cmodal-overlay';
    document.body.appendChild(overlay);
  }

  overlay.innerHTML = buildModalShell(candidate);
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';

  // Close handlers
  overlay.querySelector('.cmodal-close').addEventListener('click', closeCandidateModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeCandidateModal(); });

  // Tab clicks
  overlay.querySelectorAll('.cmodal-tab').forEach(tab => {
    tab.addEventListener('click', () => switchModalTab(tab.dataset.tab));
  });

  // Render default tab
  renderModalTab('profile');
}

function closeCandidateModal() {
  const overlay = document.getElementById('cmodal-overlay');
  if (overlay) {
    overlay.classList.remove('open');
    document.body.style.overflow = '';
  }
}

function buildModalShell(candidate) {
  const steps = candidate.stepsCompleted || {};
  const tabsHtml = TABS.map(t => {
    const done = t.step ? steps[t.step] : false;
    const locked = t.key === 'victory' && !steps.interestChecked;
    return `<button class="cmodal-tab${t.key === 'profile' ? ' active' : ''}${locked ? ' locked' : ''}" data-tab="${t.key}" ${locked ? 'title="Available after interest check is sent"' : ''}>
      ${t.label}
      ${done ? '<span class="tab-check">✓</span>' : ''}
    </button>`;
  }).join('');

  return `
    <div class="cmodal">
      <div class="cmodal-header">
        <div class="cmodal-avatar" style="background:${avatarColor(candidate.name)}">${initials(candidate.name)}</div>
        <div class="cmodal-identity">
          <div class="cmodal-name">${escapeHtml(candidate.name||'Unknown')}</div>
          <div class="cmodal-subtitle">${escapeHtml(candidate.title||'')}${candidate.title && candidate.company?' · ':''}${escapeHtml(candidate.company||'')}</div>
          <div style="margin-top:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            ${stageBadge(candidate.stage)}
            ${candidate.opened ? '<span class="badge-opened">Opened</span>' : ''}
            ${candidate.unread ? '<span class="badge-new">New</span>' : ''}
          </div>
        </div>
        <button class="cmodal-close" title="Close">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="cmodal-tabs-row">${tabsHtml}</div>
      <div class="cmodal-body" id="cmodal-body"></div>
    </div>
  `;
}

function switchModalTab(tabKey) {
  if (tabKey === 'victory' && !(_modalCandidate.stepsCompleted || {}).interestChecked) {
    Toast.warning('Send the Review email first — this tab unlocks after the interest check.');
    return;
  }
  _activeTab = tabKey;

  document.querySelectorAll('.cmodal-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabKey));
  renderModalTab(tabKey);
}

function refreshModal() {
  // Rebuild tabs area (for checkmark updates), keep tab content
  const overlay = document.getElementById('cmodal-overlay');
  if (!overlay) return;
  const steps = _modalCandidate.stepsCompleted || {};

  TABS.forEach(t => {
    const tab = overlay.querySelector(`.cmodal-tab[data-tab="${t.key}"]`);
    if (!tab) return;
    const done = t.step ? steps[t.step] : false;
    const locked = t.key === 'victory' && !steps.interestChecked;
    tab.disabled = locked;
    tab.classList.toggle('locked', locked);
    let check = tab.querySelector('.tab-check');
    if (done && !check) {
      check = document.createElement('span');
      check.className = 'tab-check';
      check.textContent = '✓';
      tab.appendChild(check);
    } else if (!done && check) {
      check.remove();
    }
    // Update header badges
    const name = overlay.querySelector('.cmodal-name');
    if (name) name.textContent = _modalCandidate.name || 'Unknown';
    const stageBadgeEl = overlay.querySelector('.stage-badge');
    if (stageBadgeEl) {
      const color = STAGE_COLORS[_modalCandidate.stage] || '#64748b';
      stageBadgeEl.style.background = color + '20';
      stageBadgeEl.style.color = color;
      stageBadgeEl.textContent = _modalCandidate.stage || 'Imported';
    }
  });
}

function renderModalTab(tabKey) {
  const body = document.getElementById('cmodal-body');
  if (!body) return;
  body.innerHTML = '<div class="tab-loading">Loading…</div>';

  switch (tabKey) {
    case 'profile':   renderProfileTab(body); break;
    case 'outreach':  renderOutreachTab(body); break;
    case 'role-jd':   renderRoleJDTab(body); break;
    case 'resume':    renderResumeTab(body); break;
    case 'review':    renderReviewTab(body); break;
    case 'victory':   renderVictoryTab(body); break;
    case 'thread':    renderThreadTab(body); break;
    default: body.innerHTML = '';
  }
}

// ================================================================
// TAB 1: PROFILE
// ================================================================

function renderProfileTab(body) {
  const c = _modalCandidate;
  const careerHtml = c.career && c.career.length > 0
    ? c.career.map(j => `
      <div class="career-item">
        <div class="career-title">${escapeHtml(j.title||'')} ${j.company?`<span class="career-co">· ${escapeHtml(j.company)}</span>`:''}</div>
        ${j.dates||j.duration?`<div class="career-dates">${escapeHtml(j.dates||j.duration)}</div>`:''}
        ${j.description?`<div class="career-desc">${escapeHtml(j.description)}</div>`:''}
      </div>`).join('')
    : '';

  const eduHtml = c.education && c.education.length > 0
    ? c.education.map(e => `
      <div class="edu-item">
        <span class="font-medium">${escapeHtml(e.degree||e.school||e.institution||'')}</span>
        ${e.school && e.degree?` <span class="text-muted">— ${escapeHtml(e.school)}</span>`:''}
        ${e.year||e.dates?` <span class="text-muted text-xs">${escapeHtml(e.year||e.dates)}</span>`:''}
      </div>`).join('')
    : '';

  body.innerHTML = `
    <div class="tab-scroll">
      <div class="tab-section">
        <h4>Contact</h4>
        <div class="form-row">
          <div class="form-group"><label>Full Name</label><input type="text" id="pf-name" value="${escapeHtml(c.name||'')}" /></div>
          <div class="form-group"><label>Email</label><input type="email" id="pf-email" value="${escapeHtml(c.email||'')}" /></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Title</label><input type="text" id="pf-title" value="${escapeHtml(c.title||'')}" /></div>
          <div class="form-group"><label>Company</label><input type="text" id="pf-company" value="${escapeHtml(c.company||'')}" /></div>
        </div>
        <div class="form-group">
          <label>LinkedIn URL</label>
          <input type="text" id="pf-linkedin" value="${escapeHtml(c.linkedin||'')}" placeholder="https://linkedin.com/in/…" />
        </div>
      </div>

      <div class="tab-section">
        <h4>Pipeline Stage</h4>
        <select id="pf-stage" style="width:auto">
          ${STAGES.map(s => `<option value="${s}" ${(c.stage||'Imported')===s?'selected':''}>${s}</option>`).join('')}
        </select>
      </div>

      <div class="tab-section">
        <h4>Background / Role Fit <span class="text-xs text-muted">(used by AI for personalization)</span></h4>
        <textarea id="pf-background" style="min-height:90px">${escapeHtml(c.background||c.summary||'')}</textarea>
      </div>

      <div class="tab-section">
        <h4>Tags</h4>
        <div class="tags-display" id="pf-tags-display">
          ${(c.tags||[]).map(t => `<span class="card-tag">${escapeHtml(t)}<span class="tag-remove" data-tag="${escapeHtml(t)}">×</span></span>`).join('')}
        </div>
        <div style="display:flex;gap:6px;margin-top:8px">
          <input type="text" id="pf-tag-input" placeholder="Add tag…" style="flex:1;width:auto" />
          <button class="btn btn-secondary btn-sm" id="pf-add-tag">Add</button>
        </div>
      </div>

      <!-- AI Score Panel -->
      <div class="tab-section">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <h4 style="margin:0">AI Candidate Score</h4>
          <button class="btn btn-ghost btn-sm" id="pf-score-btn">
            ${c.score != null ? '↺ Re-score' : '✦ Score Candidate'}
          </button>
        </div>
        ${c.scoreDetails ? (() => {
          const sc = c.scoreDetails;
          const color = sc.score >= 8 ? '#16a34a' : sc.score >= 5 ? '#d97706' : '#ef4444';
          return `
            <div style="display:flex;align-items:center;gap:16px;padding:12px;background:${color}10;border-radius:8px;border:1px solid ${color}30">
              <div style="font-size:2.5rem;font-weight:800;color:${color};line-height:1">${sc.score}<span style="font-size:1rem;font-weight:400">/10</span></div>
              <div style="flex:1">
                <div style="font-size:0.85rem;color:var(--text);line-height:1.5">${escapeHtml(sc.rationale||'')}</div>
                ${sc.strengths&&sc.strengths.length?`<div style="margin-top:8px;font-size:0.78rem;color:#16a34a">✓ ${sc.strengths.join(' · ')}</div>`:''}
                ${sc.concerns&&sc.concerns.length?`<div style="margin-top:4px;font-size:0.78rem;color:#ef4444">⚠ ${sc.concerns.join(' · ')}</div>`:''}
                <div style="font-size:0.72rem;color:var(--text-muted);margin-top:6px">Scored ${sc.scoredAt ? formatRelative(sc.scoredAt) : ''}</div>
              </div>
            </div>`;
        })() : `<p style="font-size:0.85rem;color:var(--text-muted);margin:0">Click "Score Candidate" to get an AI fit assessment (1–10) with strengths and concerns.</p>`}
      </div>

      <!-- Notes History -->
      <div class="tab-section">
        <h4>Notes <span class="save-indicator" id="notes-indicator"></span></h4>
        ${(c.notesHistory && c.notesHistory.length > 0) ? `
          <div style="margin-bottom:12px;max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:8px">
            ${[...(c.notesHistory||[])].reverse().map(n => `
              <div style="background:var(--bg-secondary);border-radius:8px;padding:10px 12px">
                <div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:4px">${escapeHtml(n.author||'Recruiter')} · ${formatRelative(n.timestamp)}</div>
                <div style="font-size:0.875rem;color:var(--text);white-space:pre-wrap">${escapeHtml(n.text)}</div>
              </div>`).join('')}
          </div>` : ''}
        <div style="display:flex;gap:8px;align-items:flex-end">
          <textarea id="pf-notes" style="min-height:72px;flex:1" placeholder="Add a note…"></textarea>
          <button class="btn btn-secondary btn-sm" id="pf-add-note" style="align-self:flex-end;white-space:nowrap">Add Note</button>
        </div>
      </div>

      ${careerHtml ? `<div class="tab-section"><h4>Career History</h4>${careerHtml}</div>` : ''}
      ${eduHtml ? `<div class="tab-section"><h4>Education</h4>${eduHtml}</div>` : ''}

      <div class="tab-section tab-actions">
        <button class="btn btn-primary btn-sm" id="pf-save">Save Profile</button>
        <button class="btn btn-danger btn-sm" id="pf-delete">Delete Candidate</button>
      </div>
    </div>
  `;

  // Stage change
  body.querySelector('#pf-stage').addEventListener('change', async e => {
    try {
      const updated = await API.candidates.update(c.id, { stage: e.target.value });
      Object.assign(_modalCandidate, updated);
      _modalOnUpdate(_modalCandidate);
      refreshModal();
      Toast.success('Stage updated');
    } catch (err) { Toast.error(err.message); }
  });

  // Tags
  body.querySelector('#pf-add-tag').addEventListener('click', async () => {
    const input = body.querySelector('#pf-tag-input');
    const tag = input.value.trim();
    if (!tag) return;
    const tags = [...(c.tags||[])];
    if (!tags.includes(tag)) {
      tags.push(tag);
      try {
        const updated = await API.candidates.update(c.id, { tags });
        Object.assign(_modalCandidate, updated);
        _modalOnUpdate(_modalCandidate);
        input.value = '';
        renderProfileTab(body);
      } catch (err) { Toast.error(err.message); }
    }
    input.value = '';
  });
  body.querySelector('#pf-tag-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); body.querySelector('#pf-add-tag').click(); }
  });
  body.querySelectorAll('.tag-remove').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation();
      const tags = (c.tags||[]).filter(t => t !== el.dataset.tag);
      try {
        const updated = await API.candidates.update(c.id, { tags });
        Object.assign(_modalCandidate, updated);
        _modalOnUpdate(_modalCandidate);
        renderProfileTab(body);
      } catch (err) { Toast.error(err.message); }
    });
  });

  // AI Score button
  const scoreBtn = body.querySelector('#pf-score-btn');
  if (scoreBtn) {
    scoreBtn.addEventListener('click', async () => {
      scoreBtn.disabled = true; scoreBtn.textContent = '✦ Scoring…';
      try {
        const result = await API.ai.score(c.id);
        Object.assign(_modalCandidate, { score: result.score, scoreDetails: { ...result, scoredAt: new Date().toISOString() } });
        _modalOnUpdate(_modalCandidate);
        renderProfileTab(body);
        Toast.success(`Scored ${result.score}/10`);
      } catch (err) { Toast.error(err.message); }
      finally { scoreBtn.disabled = false; }
    });
  }

  // Add Note button
  const addNoteBtn = body.querySelector('#pf-add-note');
  if (addNoteBtn) {
    addNoteBtn.addEventListener('click', async () => {
      const noteText = body.querySelector('#pf-notes').value.trim();
      if (!noteText) { Toast.warning('Write a note first'); return; }
      addNoteBtn.disabled = true; addNoteBtn.textContent = 'Saving…';
      try {
        const updated = await API.candidates.update(c.id, { noteText });
        Object.assign(_modalCandidate, updated);
        _modalOnUpdate(_modalCandidate);
        renderProfileTab(body);
        Toast.success('Note added');
      } catch (err) { Toast.error(err.message); }
      finally { addNoteBtn.disabled = false; addNoteBtn.textContent = 'Add Note'; }
    });
  }

  // Notes — just a plain textarea now (submitted via Add Note button, no auto-save)
  const notesEl = body.querySelector('#pf-notes');
  if (notesEl) {
    notesEl.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault(); addNoteBtn && addNoteBtn.click();
      }
    });
  }

  // Save profile
  body.querySelector('#pf-save').addEventListener('click', async () => {
    const btn = body.querySelector('#pf-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const updated = await API.candidates.update(c.id, {
        name: body.querySelector('#pf-name').value.trim(),
        email: body.querySelector('#pf-email').value.trim(),
        title: body.querySelector('#pf-title').value.trim(),
        company: body.querySelector('#pf-company').value.trim(),
        linkedin: body.querySelector('#pf-linkedin').value.trim(),
        background: body.querySelector('#pf-background').value.trim()
      });
      Object.assign(_modalCandidate, updated);
      _modalOnUpdate(_modalCandidate);
      refreshModal();
      Toast.success('Profile saved');
    } catch (err) { Toast.error(err.message); }
    finally { btn.disabled = false; btn.textContent = 'Save Profile'; }
  });

  // Delete
  body.querySelector('#pf-delete').addEventListener('click', async () => {
    const ok = await showConfirm(`Delete ${c.name}? This cannot be undone.`, 'Delete Candidate');
    if (!ok) return;
    try {
      await API.candidates.delete(c.id);
      _modalOnDelete(c.id);
      closeCandidateModal();
      Toast.success('Candidate deleted');
    } catch (err) { Toast.error(err.message); }
  });
}

// ================================================================
// TAB 2: OUTREACH
// ================================================================

function renderOutreachTab(body) {
  const c = _modalCandidate;
  const done = (c.stepsCompleted||{}).outreach;

  body.innerHTML = `
    <div class="tab-scroll">
      ${done ? `<div class="step-done-banner">✓ Outreach email has been sent</div>` : ''}
      <div class="tab-section">
        <h4>Personalized Outreach Email</h4>
        <p class="tab-desc">AI crafts a deep personalized email referencing <strong>${escapeHtml(c.name||'this candidate')}'s</strong> specific career arc. Review and approve before anything sends.</p>

        ${!done ? `<button class="btn btn-secondary btn-sm" id="gen-outreach-btn">✦ Generate Outreach</button>` : ''}
      </div>

      <div class="draft-area" id="outreach-draft-area" style="display:none">
        <div class="tab-section">
          <div class="draft-label">
            <h4>Draft — review before sending</h4>
            <span class="text-xs text-muted">Edit directly in the box below</span>
          </div>
          <div class="form-group">
            <label>Subject Line</label>
            <input type="text" id="outreach-subject" placeholder="Something Worth a Few Minutes of Your Time, [Name]" />
          </div>
          <div class="form-group">
            <label>Message</label>
            <textarea id="outreach-body" class="draft-textarea" style="min-height:280px"></textarea>
          </div>
          <div class="draft-actions">
            <button class="btn btn-ghost btn-sm" id="outreach-regen">↺ Regenerate</button>
            <button class="btn btn-primary" id="outreach-send">Approve & Send</button>
          </div>
        </div>
      </div>

      ${done ? `
        <div class="tab-section">
          <h4>Sent Messages</h4>
          <div class="sent-list">
            ${(c.thread||[]).filter(m=>m.direction==='outbound').slice(0,3).map(m=>`
              <div class="sent-item">
                <div class="sent-subject">${escapeHtml(m.subject||'(no subject)')}</div>
                <div class="sent-preview">${escapeHtml(preview55(m.body))}</div>
                <div class="sent-time text-xs text-muted">${formatRelative(m.timestamp)}</div>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="tab-section">
          <button class="btn btn-secondary btn-sm" id="gen-outreach-btn">✦ Send Another Outreach</button>
          <div class="draft-area" id="outreach-draft-area" style="display:none"></div>
        </div>
      ` : ''}
    </div>
  `;

  // Wire up generate + send
  wireAIDraft(body, {
    genBtnId: 'gen-outreach-btn',
    draftAreaId: 'outreach-draft-area',
    subjectId: 'outreach-subject',
    bodyId: 'outreach-body',
    regenBtnId: 'outreach-regen',
    sendBtnId: 'outreach-send',
    defaultSubject: `Something Worth a Few Minutes of Your Time, ${c.name.split(' ')[0]}`,
    stepKey: 'outreach',
    stageTo: 'Outreach Sent',
    generate: () => API.ai.outreach(c.id)
  });
}

// ================================================================
// TAB 3: ROLE & JD
// ================================================================

function renderRoleJDTab(body) {
  const c = _modalCandidate;
  const done = (c.stepsCompleted||{}).roleJD;

  body.innerHTML = `
    <div class="tab-scroll">
      ${done ? `<div class="step-done-banner">✓ Role JD has been sent</div>` : ''}
      <div class="tab-section">
        <h4>Tailored Leadership Role Description</h4>
        <p class="tab-desc">AI builds a customized JD for <strong>${escapeHtml(c.name||'this candidate')}</strong> — references their actual companies, mirrors their experience. Review and approve before sending.</p>
        <button class="btn btn-secondary btn-sm" id="gen-jd-btn">✦ ${done?'Regenerate Role JD':'Generate Role JD'}</button>
      </div>
      <div class="draft-area" id="jd-draft-area" style="display:none">
        <div class="tab-section">
          <div class="draft-label">
            <h4>Role Description Draft</h4>
            <div style="display:flex;gap:8px;align-items:center">
              <span class="text-xs text-muted">Markdown → formatted email on send</span>
              <button class="btn btn-ghost btn-xs" id="jd-toggle-preview">👁 Preview</button>
            </div>
          </div>
          <div class="form-group">
            <label>Subject Line</label>
            <input type="text" id="jd-subject" placeholder="The Welltower opportunity — created with you in mind" />
          </div>
          <div class="form-group" id="jd-edit-area">
            <label>Message <span class="text-xs text-muted">(markdown)</span></label>
            <textarea id="jd-body" class="draft-textarea" style="min-height:380px;font-family:monospace;font-size:13px"></textarea>
          </div>
          <div class="form-group" id="jd-preview-area" style="display:none">
            <label>Formatted Preview <span class="text-xs text-muted">(how it looks in the email)</span></label>
            <div id="jd-preview-content" style="border:1px solid var(--border);border-radius:8px;padding:20px;min-height:380px;overflow-y:auto;background:var(--bg-primary)"></div>
          </div>
          <div class="draft-actions">
            <button class="btn btn-ghost btn-sm" id="jd-regen">↺ Regenerate</button>
            <button class="btn btn-primary" id="jd-send">Approve & Send</button>
          </div>
        </div>
      </div>
    </div>
  `;

  // Preview toggle
  const toggleBtn = body.querySelector('#jd-toggle-preview');
  const editArea = body.querySelector('#jd-edit-area');
  const previewArea = body.querySelector('#jd-preview-area');
  const previewContent = body.querySelector('#jd-preview-content');
  let showingPreview = false;
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      showingPreview = !showingPreview;
      editArea.style.display = showingPreview ? 'none' : '';
      previewArea.style.display = showingPreview ? '' : 'none';
      toggleBtn.textContent = showingPreview ? '✏ Edit' : '👁 Preview';
      if (showingPreview) {
        const md = body.querySelector('#jd-body').value;
        previewContent.innerHTML = markdownToHtmlPreview(md);
      }
    });
  }

  wireAIDraft(body, {
    genBtnId: 'gen-jd-btn',
    draftAreaId: 'jd-draft-area',
    subjectId: 'jd-subject',
    bodyId: 'jd-body',
    regenBtnId: 'jd-regen',
    sendBtnId: 'jd-send',
    defaultSubject: `The Welltower opportunity — created with you in mind`,
    stepKey: 'roleJD',
    stageTo: null,
    generate: () => API.ai.roleJD(c.id)
  });
}

// ================================================================
// TAB 4: RESUME
// ================================================================

function renderResumeTab(body) {
  const c = _modalCandidate;
  const hasResume = c.resume && c.resume.text;
  const done = (c.stepsCompleted||{}).resumeRequested;

  body.innerHTML = `
    <div class="tab-scroll">
      <div class="tab-section">
        <h4>Resume Request Email</h4>
        <p class="tab-desc">Send a request for their resume. Once received, upload it here.</p>
        ${(c.stepsCompleted||{}).resumeRequested
          ? `<div class="step-done-banner">✓ Resume request sent</div>`
          : `<button class="btn btn-secondary btn-sm" id="gen-resume-req-btn">✦ Generate Resume Request Email</button>`
        }
      </div>

      <div class="draft-area" id="resume-req-draft-area" style="display:none">
        <div class="tab-section">
          <div class="form-group"><label>Subject Line</label><input type="text" id="resume-req-subject" value="Quick question about next steps" /></div>
          <div class="form-group"><label>Message</label><textarea id="resume-req-body" class="draft-textarea" style="min-height:180px"></textarea></div>
          <div class="draft-actions">
            <button class="btn btn-ghost btn-sm" id="resume-req-regen">↺ Regenerate</button>
            <button class="btn btn-primary" id="resume-req-send">Approve & Send</button>
          </div>
        </div>
      </div>

      <div class="tab-section">
        <h4>Resume on File</h4>
        ${hasResume ? `
          <div class="resume-card">
            <div class="resume-icon">📄</div>
            <div style="flex:1">
              <div class="font-medium">${escapeHtml(c.resume.filename || 'resume')}</div>
              <div class="text-xs text-muted">${c.resume.uploadedAt ? formatDate(c.resume.uploadedAt) : 'No date'}</div>
            </div>
            <button class="btn btn-secondary btn-sm" id="download-resume-btn">Download</button>
          </div>
          <div class="resume-preview">${escapeHtml(c.resume.text.substring(0, 1500))}${c.resume.text.length > 1500 ? '\n…' : ''}</div>
        ` : `<div class="text-muted text-sm">No resume uploaded yet.</div>`}
      </div>

      <div class="tab-section">
        <h4>Upload Resume (PDF or DOCX)</h4>
        <div style="display:flex;flex-direction:column;gap:8px">
          <input type="file" id="resume-file-input" accept=".pdf,.docx" />
          <button class="btn btn-primary btn-sm" id="upload-resume-btn" style="align-self:flex-start">Upload & Extract Text</button>
        </div>
      </div>

      <div class="tab-section">
        <h4>Or Paste Resume Text</h4>
        <textarea id="resume-paste" placeholder="Paste resume text here…" style="min-height:120px"></textarea>
        <button class="btn btn-secondary btn-sm" id="save-paste-btn" style="margin-top:8px">Save Text</button>
      </div>

      ${!hasResume ? `
      <div class="tab-section">
        <button class="btn btn-secondary btn-sm" id="mark-received-btn">✓ Mark Resume as Received</button>
      </div>` : ''}
    </div>
  `;

  // Resume request email
  if (!done) {
    wireAIDraft(body, {
      genBtnId: 'gen-resume-req-btn',
      draftAreaId: 'resume-req-draft-area',
      subjectId: 'resume-req-subject',
      bodyId: 'resume-req-body',
      regenBtnId: 'resume-req-regen',
      sendBtnId: 'resume-req-send',
      defaultSubject: 'Quick question about next steps',
      stepKey: 'resumeRequested',
      stageTo: 'Resume Requested',
      generate: async () => {
        const draft = await API.ai.reply(c.id);
        return { draft: draft.draft };
      }
    });
  }

  // Download
  if (hasResume) {
    body.querySelector('#download-resume-btn').addEventListener('click', () => API.candidates.downloadResume(c.id));
  }

  // Upload
  body.querySelector('#upload-resume-btn').addEventListener('click', async () => {
    const file = body.querySelector('#resume-file-input').files[0];
    if (!file) { Toast.warning('Select a file first'); return; }
    const btn = body.querySelector('#upload-resume-btn');
    btn.disabled = true; btn.textContent = 'Uploading…';
    try {
      const fd = new FormData();
      fd.append('resume', file);
      const result = await API.candidates.uploadResume(c.id, fd);
      Object.assign(_modalCandidate, result.candidate);
      _modalOnUpdate(_modalCandidate);
      refreshModal();
      Toast.success('Resume uploaded and text extracted');
      renderResumeTab(body);
    } catch (err) { Toast.error(err.message); }
    finally { btn.disabled = false; btn.textContent = 'Upload & Extract Text'; }
  });

  // Paste text
  body.querySelector('#save-paste-btn').addEventListener('click', async () => {
    const text = body.querySelector('#resume-paste').value.trim();
    if (!text) { Toast.warning('Paste some text first'); return; }
    try {
      const updated = await API.candidates.update(c.id, {
        resume: { text, filename: 'pasted-resume.txt', uploadedAt: new Date().toISOString() },
        stepsCompleted: { ...(c.stepsCompleted||{}), resumeReceived: true },
        stage: 'Resume Received'
      });
      Object.assign(_modalCandidate, updated);
      _modalOnUpdate(_modalCandidate);
      refreshModal();
      Toast.success('Resume text saved');
      renderResumeTab(body);
    } catch (err) { Toast.error(err.message); }
  });

  // Mark received
  const markBtn = body.querySelector('#mark-received-btn');
  if (markBtn) {
    markBtn.addEventListener('click', async () => {
      try {
        const updated = await API.candidates.update(c.id, {
          stepsCompleted: { ...(c.stepsCompleted||{}), resumeReceived: true },
          stage: 'Resume Received'
        });
        Object.assign(_modalCandidate, updated);
        _modalOnUpdate(_modalCandidate);
        refreshModal();
        Toast.success('Marked as received');
        renderResumeTab(body);
      } catch (err) { Toast.error(err.message); }
    });
  }
}

// ================================================================
// TAB 5: REVIEW
// ================================================================

function renderReviewTab(body) {
  const c = _modalCandidate;
  const hasResume = c.resume && c.resume.text;
  const done = (c.stepsCompleted||{}).reviewSent;

  if (!hasResume) {
    body.innerHTML = `
      <div class="tab-scroll">
        <div class="empty-state" style="padding:40px 20px">
          <div class="empty-icon">📄</div>
          <h3>Resume Required</h3>
          <p>Upload ${escapeHtml(c.name||'the candidate')}'s resume in the Resume tab first.</p>
          <button class="btn btn-secondary btn-sm" onclick="switchModalTab('resume')">Go to Resume Tab →</button>
        </div>
      </div>
    `;
    return;
  }

  body.innerHTML = `
    <div class="tab-scroll">
      ${done ? `<div class="step-done-banner">✓ Resume review email sent — Victory tab now available</div>` : ''}
      <div class="tab-section">
        <h4>AI Resume Review</h4>
        <p class="tab-desc">AI identifies 3-4 specific, concrete gaps in ${escapeHtml(c.name||'the candidate')}'s resume (referencing actual content). Then drafts a warm email asking if they're open to professional support — <strong>does not mention Victory yet</strong>.</p>
        <button class="btn btn-secondary btn-sm" id="gen-review-btn">✦ ${done?'Regenerate Review':'Run Resume Review'}</button>
      </div>

      <div id="gaps-display" style="display:none" class="tab-section">
        <div class="gaps-box">
          <h4>Identified Gaps</h4>
          <div id="gaps-text" class="gaps-content"></div>
        </div>
      </div>

      <div class="draft-area" id="review-draft-area" style="display:none">
        <div class="tab-section">
          <div class="draft-label"><h4>Draft — Interest Check Email</h4><span class="text-xs text-muted">Edit before sending — does not mention Victory</span></div>
          <div class="form-group"><label>Subject Line</label><input type="text" id="review-subject" value="Quick thought on your background" /></div>
          <div class="form-group"><label>Message</label><textarea id="review-body" class="draft-textarea" style="min-height:220px"></textarea></div>
          <div class="draft-actions">
            <button class="btn btn-ghost btn-sm" id="review-regen">↺ Regenerate</button>
            <button class="btn btn-primary" id="review-send">Approve & Send</button>
          </div>
        </div>
      </div>
    </div>
  `;

  body.querySelector('#gen-review-btn').addEventListener('click', async () => {
    const btn = body.querySelector('#gen-review-btn');
    btn.disabled = true; btn.textContent = '✦ Analyzing…';
    try {
      const result = await API.ai.resumeReview(c.id);
      // Show gaps
      const gapsDiv = body.querySelector('#gaps-display');
      const gapsText = body.querySelector('#gaps-text');
      if (result.gaps) {
        gapsText.textContent = result.gaps;
        gapsDiv.style.display = '';
      }
      // Show draft
      const draftArea = body.querySelector('#review-draft-area');
      const draftBody = body.querySelector('#review-body');
      if (result.draft) {
        draftBody.value = result.draft;
        draftArea.style.display = '';
      }
    } catch (err) { Toast.error(err.message); }
    finally { btn.disabled = false; btn.textContent = '✦ ' + (done?'Regenerate Review':'Run Resume Review'); }
  });

  body.querySelector('#review-regen') && body.querySelector('#review-regen').addEventListener('click', () => {
    body.querySelector('#gen-review-btn').click();
  });

  body.querySelector('#review-send') && body.querySelector('#review-send').addEventListener('click', async () => {
    const subject = body.querySelector('#review-subject').value.trim() || 'Quick thought on your background';
    const msgBody = body.querySelector('#review-body').value.trim();
    if (!msgBody) { Toast.warning('Draft is empty'); return; }
    const btn = body.querySelector('#review-send');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const result = await API.email.send({ candidateId: c.id, subject, body: msgBody, isReply: (c.thread||[]).length > 0 });
      const stepsUpdate = { stepsCompleted: { ...(c.stepsCompleted||{}), reviewSent: true, interestChecked: true } };
      const updated = await API.candidates.update(c.id, stepsUpdate);
      Object.assign(_modalCandidate, result.candidate || {}, updated);
      _modalOnUpdate(_modalCandidate);
      refreshModal();
      Toast.success('Review email sent — Victory tab is now unlocked');
      renderReviewTab(body);
    } catch (err) { Toast.error(err.message); }
    finally { btn.disabled = false; btn.textContent = 'Approve & Send'; }
  });
}

// ================================================================
// TAB 6: VICTORY
// ================================================================

function renderVictoryTab(body) {
  const c = _modalCandidate;
  const done = (c.stepsCompleted||{}).victorySent;

  body.innerHTML = `
    <div class="tab-scroll">
      ${done ? `<div class="step-done-banner">✓ Victory introduction sent</div>` : ''}
      <div class="tab-section">
        <h4>Victory at Toby Career Consults</h4>
        <p class="tab-desc">AI drafts a warm, personal introduction to Victory (victory@tobycareerconsults.com) who specializes in executive resume writing. Feels like a genuine recommendation, not a sales pitch.</p>
        <button class="btn btn-secondary btn-sm" id="gen-victory-btn">✦ ${done?'Regenerate Victory Email':'Generate Victory Email'}</button>
      </div>
      <div class="draft-area" id="victory-draft-area" style="display:none">
        <div class="tab-section">
          <div class="draft-label"><h4>Draft — Victory Introduction</h4><span class="text-xs text-muted">Edit before sending</span></div>
          <div class="form-group"><label>Subject Line</label><input type="text" id="victory-subject" value="Someone I think you should connect with" /></div>
          <div class="form-group"><label>Message</label><textarea id="victory-body" class="draft-textarea" style="min-height:240px"></textarea></div>
          <div class="draft-actions">
            <button class="btn btn-ghost btn-sm" id="victory-regen">↺ Regenerate</button>
            <button class="btn btn-primary" id="victory-send">Approve & Send</button>
          </div>
        </div>
      </div>
    </div>
  `;

  wireAIDraft(body, {
    genBtnId: 'gen-victory-btn',
    draftAreaId: 'victory-draft-area',
    subjectId: 'victory-subject',
    bodyId: 'victory-body',
    regenBtnId: 'victory-regen',
    sendBtnId: 'victory-send',
    defaultSubject: 'Someone I think you should connect with',
    stepKey: 'victorySent',
    stageTo: null,
    generate: () => API.ai.victory(c.id)
  });
}

// ================================================================
// TAB 7: THREAD
// ================================================================

function renderThreadTab(body) {
  const c = _modalCandidate;
  const thread = c.thread || [];

  const threadHtml = thread.length === 0
    ? `<div class="thread-empty">No messages yet. Send an outreach to start the conversation.</div>`
    : thread.map(msg => `
      <div class="thread-msg ${msg.direction||'outbound'}">
        <div class="thread-msg-header">
          <span class="thread-direction">${msg.direction === 'inbound' ? `↙ ${escapeHtml(c.name||'Candidate')}` : '↗ You'}</span>
          <span class="thread-time">${formatRelative(msg.timestamp)}</span>
        </div>
        ${msg.subject ? `<div class="thread-subject">${escapeHtml(msg.subject)}</div>` : ''}
        <div class="thread-body">${escapeHtml(msg.body||'').replace(/\n/g,'<br>')}</div>
      </div>
    `).join('');

  body.innerHTML = `
    <div class="thread-container">
      <div class="thread-messages" id="thread-msgs">${threadHtml}</div>

      <div class="compose-area">
        <div class="compose-header">
          <h4>Compose</h4>
          <div class="compose-ai-btns">
            <button class="btn btn-ghost btn-sm" id="th-gen-reply">✦ Draft Reply</button>
            <button class="btn btn-ghost btn-sm" id="th-gen-outreach">✦ Outreach</button>
            <button class="btn btn-ghost btn-sm" id="th-gen-jd">✦ Role JD</button>
          </div>
        </div>
        <div class="form-group" style="margin-bottom:8px">
          <input type="text" id="th-subject" placeholder="Subject line…" value="${escapeHtml(c.lastSubject ? 'Re: ' + c.lastSubject.replace(/^Re:\s*/i,'') : '')}" />
        </div>
        <textarea id="th-body" class="compose-textarea" placeholder="Type your message…"></textarea>
        <div class="compose-footer">
          <span class="text-xs text-muted">All sends require your approval above</span>
          <button class="btn btn-primary" id="th-send">Send Email</button>
        </div>
      </div>
    </div>
  `;

  // Scroll thread to bottom
  const msgsEl = body.querySelector('#thread-msgs');
  if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;

  // AI buttons
  async function aiGenerate(type) {
    const btn = body.querySelector(`#th-gen-${type}`);
    const origText = btn.textContent;
    btn.disabled = true; btn.textContent = '…';
    try {
      let result;
      if (type === 'reply') {
        const lastInbound = [...thread].reverse().find(m => m.direction === 'inbound');
        result = await API.ai.reply(c.id, lastInbound ? lastInbound.body : null);
      } else if (type === 'outreach') {
        result = await API.ai.outreach(c.id);
      } else if (type === 'jd') {
        result = await API.ai.roleJD(c.id);
      }
      if (result && result.draft) {
        body.querySelector('#th-body').value = result.draft;
        if (type === 'outreach' && !body.querySelector('#th-subject').value) {
          body.querySelector('#th-subject').value = `Something Worth a Few Minutes of Your Time, ${c.name.split(' ')[0]}`;
        }
        body.querySelector('#th-body').focus();
      }
    } catch (err) { Toast.error(err.message); }
    finally { btn.disabled = false; btn.textContent = origText; }
  }

  body.querySelector('#th-gen-reply').addEventListener('click', () => aiGenerate('reply'));
  body.querySelector('#th-gen-outreach').addEventListener('click', () => aiGenerate('outreach'));
  body.querySelector('#th-gen-jd').addEventListener('click', () => aiGenerate('jd'));

  // Send
  body.querySelector('#th-send').addEventListener('click', async () => {
    const subject = body.querySelector('#th-subject').value.trim();
    const msgBody = body.querySelector('#th-body').value.trim();
    if (!subject) { Toast.warning('Subject line required'); return; }
    if (!msgBody) { Toast.warning('Message body is empty'); return; }

    const btn = body.querySelector('#th-send');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const isReply = thread.some(m => m.direction === 'outbound');
      const result = await API.email.send({ candidateId: c.id, subject, body: msgBody, isReply });
      if (result.candidate) Object.assign(_modalCandidate, result.candidate);
      _modalOnUpdate(_modalCandidate);
      Toast.success('Email sent');
      renderThreadTab(body);
    } catch (err) { Toast.error(err.message); }
    finally { btn.disabled = false; btn.textContent = 'Send Email'; }
  });
}

// ================================================================
// SHARED: AI Draft Wire-up
// ================================================================

function wireAIDraft(body, { genBtnId, draftAreaId, subjectId, bodyId, regenBtnId, sendBtnId, defaultSubject, stepKey, stageTo, generate }) {
  const c = _modalCandidate;

  const genBtn = body.querySelector('#' + genBtnId);
  const draftArea = body.querySelector('#' + draftAreaId);
  if (!genBtn || !draftArea) return;

  async function doGenerate() {
    const orig = genBtn.textContent;
    genBtn.disabled = true; genBtn.textContent = '✦ Generating…';
    try {
      const result = await generate();
      const draft = result.draft || result;
      const subjectEl = body.querySelector('#' + subjectId);
      const bodyEl = body.querySelector('#' + bodyId);
      if (bodyEl) bodyEl.value = draft;
      if (subjectEl && !subjectEl.value) subjectEl.value = defaultSubject;
      draftArea.style.display = '';
      bodyEl && bodyEl.focus();
    } catch (err) { Toast.error(err.message); }
    finally { genBtn.disabled = false; genBtn.textContent = orig; }
  }

  genBtn.addEventListener('click', doGenerate);

  const regenBtn = body.querySelector('#' + regenBtnId);
  if (regenBtn) regenBtn.addEventListener('click', doGenerate);

  const sendBtn = body.querySelector('#' + sendBtnId);
  if (sendBtn) {
    sendBtn.addEventListener('click', async () => {
      const subjectEl = body.querySelector('#' + subjectId);
      const bodyEl = body.querySelector('#' + bodyId);
      const subject = subjectEl ? subjectEl.value.trim() : defaultSubject;
      const msgBody = bodyEl ? bodyEl.value.trim() : '';
      if (!msgBody) { Toast.warning('Draft is empty'); return; }

      sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
      try {
        const isReply = (c.thread||[]).some(m => m.direction === 'outbound');
        const result = await API.email.send({ candidateId: c.id, subject, body: msgBody, isReply });
        if (result.candidate) Object.assign(_modalCandidate, result.candidate);

        // Mark step complete
        const stepsUpdate = { stepsCompleted: { ...(c.stepsCompleted||{}), [stepKey]: true } };
        if (stageTo) stepsUpdate.stage = stageTo;
        const updated = await API.candidates.update(c.id, stepsUpdate);
        Object.assign(_modalCandidate, updated);
        _modalOnUpdate(_modalCandidate);
        refreshModal();
        Toast.success('Email sent');
        renderModalTab(_activeTab);
      } catch (err) { Toast.error(err.message); }
      finally { sendBtn.disabled = false; sendBtn.textContent = 'Approve & Send'; }
    });
  }
}
