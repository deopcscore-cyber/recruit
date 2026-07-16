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

// Display labels vary by user type — stored stage values never change, only
// what the user sees. Consultants sell a service, they don't run interviews.
const STAGE_LABELS_CONSULTANT = {
  'Imported': 'Leads',
  'Resume Received': 'Feedback Stage',
  'Interviewing': 'Proposal Sent',
  'Closed': 'Closed'
};

function stageLabel(stage) {
  const u = (typeof currentUser !== 'undefined' && currentUser) || window.currentUser;
  if (u && u.userType === 'career_consultant') {
    return STAGE_LABELS_CONSULTANT[stage] || stage;
  }
  return stage;
}

// Candidates can carry legacy/foreign stage values (e.g. 'Introduced' from a
// CC referral) — normalize to a real column so they never vanish off the board
function normalizeStage(stage) {
  return STAGES.includes(stage) ? stage : 'Imported';
}

// Tabs vary by user type — career consultants skip Role & JD, rename Intro → Proposal
const TABS_RECRUITER = [
  { key: 'profile',   label: 'Profile',    step: null },
  { key: 'outreach',  label: 'Outreach',   step: 'outreach' },
  { key: 'role-jd',   label: 'Role & JD',  step: 'roleJD' },
  { key: 'resume',    label: 'Resume',      step: 'resumeReceived' },
  { key: 'review',    label: 'Review',      step: 'reviewSent' },
  { key: 'victory',   label: 'Intro',       step: 'victorySent' },
  { key: 'thread',    label: 'Thread',      step: null }
];

const TABS_CONSULTANT = [
  { key: 'profile',   label: 'Profile',    step: null },
  { key: 'outreach',  label: 'Outreach',   step: 'outreach' },
  { key: 'resume',    label: 'Resume',      step: 'resumeReceived' },
  { key: 'review',    label: 'Feedback',    step: 'reviewSent' },
  { key: 'victory',   label: 'Proposal',    step: 'victorySent' },
  { key: 'thread',    label: 'Thread',      step: null }
];

function getTabs(user) {
  return (user && user.userType === 'career_consultant') ? TABS_CONSULTANT : TABS_RECRUITER;
}

// Keep a single TABS reference for backwards compat
const TABS = TABS_RECRUITER;

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
  const clean = stripHtml(stripQuotedText(text)).replace(/\s+/g, ' ').trim();
  return clean.length > 55 ? clean.substring(0, 55) + '…' : clean;
}

// Returns true if string looks like HTML
function looksLikeHtml(str) {
  return /<[a-z][\s\S]*>/i.test(str || '');
}

// Strip quoted reply history from an HTML email body using DOM parsing.
// Removes Gmail quote divs, blockquotes, and Outlook reply headers.
// Returns { html, trimmed } — trimmed=true if anything was removed.
function stripHtmlQuotes(html) {
  const wrap = document.createElement('div');
  wrap.innerHTML = html;

  const before = wrap.innerHTML.length;

  // Gmail / Google Workspace quote containers
  wrap.querySelectorAll('[class*="gmail_quote"], [class*="gmail_attr"]').forEach(el => el.remove());
  // Blockquote with cite attr (Apple Mail, Thunderbird)
  wrap.querySelectorAll('blockquote[type="cite"]').forEach(el => el.remove());
  // Outlook reply header + blockquote pairs
  wrap.querySelectorAll('[class*="OutlookMessageHeader"], [class*="ms-outlook"]').forEach(el => el.remove());
  // Common Outlook/Exchange class patterns
  wrap.querySelectorAll('[class*="WordSection"], [class*="MsoNormal"]').forEach(el => {
    // Only remove if they contain "From:" / "Sent:" attribution markers
    if (/\b(From|Sent|To|Subject):/i.test(el.innerText || el.textContent || '')) el.remove();
  });
  // Any remaining plain <blockquote> elements that are likely quote wrappers
  wrap.querySelectorAll('blockquote').forEach(el => el.remove());

  // Remove trailing empty nodes left behind
  while (wrap.lastChild && (wrap.lastChild.nodeType === 3
    ? !wrap.lastChild.textContent.trim()
    : !wrap.lastChild.textContent.trim())) {
    wrap.removeChild(wrap.lastChild);
  }

  const after  = wrap.innerHTML.length;
  const result = wrap.innerHTML.trim();
  return { html: result || html, trimmed: after < before && !!result };
}

// Strip the quoted original / reply history that mail clients append to plain-text replies.
// (Gmail "On … wrote:", Outlook "From:/Sent:/-----Original Message-----",
// ">" quote markers, divider rules). Returns just the new content. Falls back
// to the full text if stripping would leave nothing.
function stripQuotedText(text) {
  if (!text) return '';
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let cut = -1;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    // Gmail / Apple Mail attribution line ("On <date>… wrote:")
    if (/^On\b.*\bwrote:?\s*$/i.test(l)) { cut = i; break; }
    // Attribution that wraps: starts with "On " here, "… wrote:" on a later line
    if (/^On\b.+\b(at|,)\b/i.test(l) && /wrote:?\s*$/i.test((lines[i + 1] || '').trim())) { cut = i; break; }
    // Outlook / generic original-message markers
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(l)) { cut = i; break; }
    if (/^_{10,}$/.test(l)) { cut = i; break; }            // Outlook divider rule
    if (/^From:\s.+/i.test(l) &&
        /^(Sent|To|Subject|Date):/im.test(lines.slice(i + 1, i + 4).join('\n'))) { cut = i; break; }
    // First ">"-quoted line
    if (/^>/.test(lines[i])) { cut = i; break; }
  }

  if (cut === -1) return text;
  const visible = lines.slice(0, cut).join('\n').replace(/\s+$/, '');
  return visible.trim() ? visible : text;
}

function stageBadge(stage) {
  const norm = normalizeStage(stage || 'Imported');
  const color = STAGE_COLORS[norm] || '#64748b';
  return `<span class="stage-badge" style="background:${color}20;color:${color};border-color:${color}40">${stageLabel(norm)}</span>`;
}

// Auto-classified reply sentiment → coloured chip on candidate cards
const SENTIMENT_META = {
  interested:     { label: '🔥 Interested', bg: '#dcfce7', fg: '#15803d' },
  question:       { label: '❔ Question',    bg: '#dbeafe', fg: '#1d4ed8' },
  not_now:        { label: '🕒 Not now',     bg: '#fef9c3', fg: '#a16207' },
  not_interested: { label: '✕ Declined',    bg: '#fee2e2', fg: '#b91c1c' }
};
function sentimentBadge(s) {
  const m = SENTIMENT_META[s];
  if (!m) return '';
  return `<span title="Auto-detected reply sentiment" style="font-size:0.68rem;font-weight:600;background:${m.bg};color:${m.fg};border-radius:10px;padding:1px 7px">${m.label}</span>`;
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
    const count = candidates.filter(c => normalizeStage(c.stage || 'Imported') === s).length;
    const color = STAGE_COLORS[s];
    return `<div class="metric-pill" style="border-color:${color}40;background:${color}12" title="${stageLabel(s)}">
      <span class="metric-count" style="color:${color}">${count}</span>
      <span class="metric-label">${stageLabel(s)}</span>
    </div>`;
  }).join('');
}

// ---- Pipeline Board ----

function renderPipelineBoard(candidates, onCardClick) {
  const board = document.getElementById('pipeline-board');
  if (!board) return;
  board.innerHTML = '';

  STAGES.forEach(stage => {
    const stageCandidates = candidates.filter(c => normalizeStage(c.stage || 'Imported') === stage);
    const col = document.createElement('div');
    col.className = 'pipeline-column';
    col.dataset.stage = stage;
    const color = STAGE_COLORS[stage];

    col.innerHTML = `
      <div class="column-header" style="border-top:3px solid ${color}">
        <span class="column-title">${stageLabel(stage)}</span>
        <span class="column-count" style="background:${color}20;color:${color}">${stageCandidates.length}</span>
      </div>
      <div class="column-cards" id="col-${stage.replace(/\s+/g,'-')}"></div>
    `;
    board.appendChild(col);

    const cardsEl = col.querySelector('.column-cards');
    if (stageCandidates.length === 0) {
      cardsEl.innerHTML = `<div class="col-empty">No candidates</div>`;
    } else {
      stageCandidates.sort((a,b) => new Date(candidateLastActivity(b)||0) - new Date(candidateLastActivity(a)||0)).forEach(c => {
        const card = createCandidateCard(c);
        card.addEventListener('click', () => onCardClick(c));
        cardsEl.appendChild(card);
      });
    }
  });
}

// Single source of truth for "how recently active" a candidate is — used by
// both the board's sort and each card's displayed date, so they can't drift
// apart (updatedAt gets bumped by things that aren't real activity, like an
// open-tracking hit or a background re-evaluation, which used to sort a card
// to the top while it still displayed an old date).
function candidateLastActivity(candidate) {
  const lastMsg = candidate.thread && candidate.thread.length > 0
    ? candidate.thread[candidate.thread.length - 1]
    : null;
  return lastMsg ? lastMsg.timestamp : candidate.updatedAt;
}

function createCandidateCard(candidate) {
  const card = document.createElement('div');
  card.className = 'candidate-card' + (candidate.unread ? ' unread' : '');
  card.dataset.id = candidate.id;

  const lastMsg = candidate.thread && candidate.thread.length > 0
    ? candidate.thread[candidate.thread.length - 1]
    : null;
  const lastActivity = candidateLastActivity(candidate);
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
          ${sentimentBadge(candidate.replySentiment)}
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
  const steps   = candidate.stepsCompleted || {};
  const isConsultant = _modalUser && _modalUser.userType === 'career_consultant';
  const tabs    = getTabs(_modalUser);
  const tabsHtml = tabs.map(t => {
    const done   = t.step ? steps[t.step] : false;
    // Proposal (victory tab) unlocks after review/feedback is sent
    const locked = t.key === 'victory' && !steps.reviewSent;
    const lockMsg = isConsultant
      ? 'Send the Feedback email first — Proposal unlocks after that'
      : 'Send the Review email first — the Intro unlocks after that';
    return `<button class="cmodal-tab${t.key === 'profile' ? ' active' : ''}${locked ? ' locked' : ''}" data-tab="${t.key}" ${locked ? `title="${lockMsg}"` : ''}>
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
  if (tabKey === 'victory' && !(_modalCandidate.stepsCompleted || {}).reviewSent) {
    const isConsultant = _modalUser && _modalUser.userType === 'career_consultant';
    Toast.warning(isConsultant
      ? 'Send the Feedback email first — Proposal unlocks after that.'
      : 'Send the Review email first — the Intro unlocks after that.'
    );
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
      const normStage = normalizeStage(_modalCandidate.stage || 'Imported');
      const color = STAGE_COLORS[normStage] || '#64748b';
      stageBadgeEl.style.background = color + '20';
      stageBadgeEl.style.color = color;
      stageBadgeEl.textContent = stageLabel(normStage);
    }
  });
}

function draftStorageKey(candidateId, fieldId) {
  return `recruit_draft_${candidateId}_${fieldId}`;
}

function clearDraft(candidateId, fieldId) {
  localStorage.removeItem(draftStorageKey(candidateId, fieldId));
}

function initDraftTextareas(body, candidateId) {
  // Handle both <textarea class="draft-textarea"> and <input class="draft-input">
  body.querySelectorAll('textarea.draft-textarea, input.draft-input').forEach(el => {
    if (!el.id) return;
    const key = draftStorageKey(candidateId, el.id);
    const saved = localStorage.getItem(key);
    if (saved && !el.value) {
      el.value = saved;
      // Show the draft area if it's hidden
      const draftArea = el.closest('.draft-area');
      if (draftArea) draftArea.style.display = '';
      const badge = document.createElement('span');
      badge.textContent = '• Draft restored';
      badge.style.cssText = 'font-size:0.73rem;color:#d97706;margin-left:8px;display:inline-block';
      const label = el.closest('.form-group')?.querySelector('label');
      if (label) label.appendChild(badge);
      setTimeout(() => badge.remove(), 4000);
    }
    el.addEventListener('input', () => localStorage.setItem(key, el.value));
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

  if (tabKey !== 'profile' && tabKey !== 'thread' && _modalCandidate) {
    initDraftTextareas(body, _modalCandidate.id);
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
          ${STAGES.map(s => `<option value="${s}" ${normalizeStage(c.stage||'Imported')===s?'selected':''}>${stageLabel(s)}</option>`).join('')}
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

        ${!done ? `<button class="btn btn-secondary btn-sm" id="gen-outreach-btn">✦ Generate Outreach</button>
        <div style="margin-top:8px">
          <button type="button" onclick="(function(){var w=document.getElementById('outreach-instructions-wrap');w.style.display=w.style.display==='none'?'':'none'})()" class="btn btn-ghost btn-sm" style="font-size:0.75rem;padding:2px 8px;color:var(--text-muted)">✎ Add instructions</button>
          <div id="outreach-instructions-wrap" style="display:none;margin-top:6px">
            <textarea id="outreach-instructions" placeholder="e.g. mention our relocation package, keep it under 3 sentences, more formal tone…" style="width:100%;height:56px;font-size:0.82rem;resize:vertical;border:1px solid var(--border);border-radius:6px;padding:8px"></textarea>
          </div>
        </div>` : ''}
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
    defaultSubject: (_modalUser && _modalUser.userType === 'career_consultant')
      ? `A thought on your background, ${c.name ? c.name.trim().split(/\s+/)[0] : ''}`
      : `Something Worth a Few Minutes of Your Time, ${c.name ? c.name.trim().split(/\s+/)[0] : ''}`,
    stepKey: 'outreach',
    stageTo: 'Outreach Sent',
    instructionsId: 'outreach-instructions',
    generate: (instructions) => API.ai.outreach(c.id, instructions)
  });
}

// ================================================================
// TAB 3: ROLE & JD
// ================================================================

function renderRoleJDTab(body) {
  const c = _modalCandidate;
  const done = (c.stepsCompleted||{}).roleJD;
  let jdVariants = null;
  let jdLocationVal = '';

  body.innerHTML = `
    <div class="tab-scroll">
      ${done ? `<div class="step-done-banner">✓ Role JD has been sent</div>` : ''}
      <div class="tab-section">
        <h4>Tailored Leadership Role — The Step Up</h4>
        <p class="tab-desc">AI writes a short personal email for <strong>${escapeHtml(c.name||'this candidate')}</strong> that responds to their last message, plus one step-up role description attached as a formatted PDF. The email invites them to say so if they're not ready for this kind of step — you may have something else for them.</p>
        <button class="btn btn-secondary btn-sm" id="gen-jd-btn">✦ ${done?'Regenerate':'Generate Email + Role PDF'}</button>
        <div style="margin-top:8px">
          <button type="button" onclick="(function(){var w=document.getElementById('jd-instructions-wrap');w.style.display=w.style.display==='none'?'':'none'})()" class="btn btn-ghost btn-sm" style="font-size:0.75rem;padding:2px 8px;color:var(--text-muted)">✎ Add instructions</button>
          <div id="jd-instructions-wrap" style="display:none;margin-top:6px">
            <textarea id="jd-instructions" placeholder="e.g. emphasize the remote work option, highlight equity compensation…" style="width:100%;height:56px;font-size:0.82rem;resize:vertical;border:1px solid var(--border);border-radius:6px;padding:8px"></textarea>
          </div>
        </div>
      </div>
      <div class="draft-area" id="jd-draft-area" style="display:none">
        <div class="tab-section">
          <div class="draft-label">
            <h4>Email Draft</h4>
          </div>
          <div class="form-group">
            <label>Subject Line</label>
            <input type="text" id="jd-subject" placeholder="A quick thought on your next move" />
          </div>
          <div class="form-group" id="jd-edit-area">
            <label>Message</label>
            <textarea id="jd-body" class="draft-textarea" style="min-height:260px;font-size:13.5px"></textarea>
          </div>
          <div id="jd-variants-preview" style="margin:10px 0"></div>
          <div class="draft-actions">
            <button class="btn btn-ghost btn-sm" id="jd-regen">↺ Regenerate</button>
            <button class="btn btn-secondary btn-sm" id="jd-preview-pdf" style="display:none">👁 Preview PDF</button>
            <button class="btn btn-primary" id="jd-send">Approve & Send</button>
          </div>
        </div>
      </div>
    </div>
  `;

  function renderVariantsPreview() {
    const el = body.querySelector('#jd-variants-preview');
    const previewBtn = body.querySelector('#jd-preview-pdf');
    if (previewBtn) previewBtn.style.display = (jdVariants && jdVariants.length) ? '' : 'none';
    if (!el) return;
    if (!jdVariants || !jdVariants.length) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div style="border:1px solid var(--border);border-radius:8px;padding:12px 14px;background:var(--bg-primary)">
        <div style="font-size:0.78rem;font-weight:600;color:var(--text-muted);margin-bottom:8px">📎 ${jdVariants.length} role variant${jdVariants.length===1?'':'s'} will be attached as a PDF</div>
        ${jdVariants.map(v => `
          <div style="padding:6px 0;border-top:1px solid var(--border)">
            <div style="font-size:0.72rem;font-weight:700;color:var(--blue);text-transform:uppercase;letter-spacing:0.03em">${escapeHtml(v.variantLabel || 'Role option')}</div>
            <div style="font-size:0.88rem;font-weight:600;color:var(--text)">${escapeHtml(v.title || '')}</div>
          </div>`).join('')}
      </div>`;
  }

  wireAIDraft(body, {
    genBtnId: 'gen-jd-btn',
    draftAreaId: 'jd-draft-area',
    subjectId: 'jd-subject',
    bodyId: 'jd-body',
    regenBtnId: 'jd-regen',
    sendBtnId: 'jd-send',
    defaultSubject: `A quick thought on your next move`,
    stepKey: 'roleJD',
    stageTo: null,
    instructionsId: 'jd-instructions',
    generate: (instructions) => API.ai.roleJD(c.id, instructions),
    onGenerated: (result) => {
      jdVariants = result.variants || null;
      jdLocationVal = result.jdLocation || '';
      renderVariantsPreview();
    },
    extraSendParams: () => (jdVariants && jdVariants.length
      ? { roleJDVariants: jdVariants, jdLocation: jdLocationVal }
      : {})
  });

  const previewBtn = body.querySelector('#jd-preview-pdf');
  if (previewBtn) {
    previewBtn.addEventListener('click', async () => {
      if (!jdVariants || !jdVariants.length) { Toast.warning('Generate the role description first'); return; }
      // Open the tab synchronously (inside the click handler) so browsers
      // don't treat it as an unrequested popup — we fill in its URL once the
      // PDF bytes come back from the async fetch below.
      const previewWin = window.open('', '_blank');
      const orig = previewBtn.textContent;
      previewBtn.disabled = true; previewBtn.textContent = 'Loading…';
      try {
        const blob = await API.email.previewRoleJDPdf(c.id, jdVariants, jdLocationVal);
        const url = URL.createObjectURL(blob);
        if (previewWin) previewWin.location.href = url;
        else Toast.warning('Preview blocked by your browser\'s pop-up blocker — allow pop-ups for this site and try again.');
      } catch (err) {
        if (previewWin) previewWin.close();
        Toast.error(err.message);
      } finally {
        previewBtn.disabled = false; previewBtn.textContent = orig;
      }
    });
  }
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
          : `<button class="btn btn-secondary btn-sm" id="gen-resume-req-btn">✦ Generate Resume Request Email</button>
          <div style="margin-top:8px">
            <button type="button" onclick="(function(){var w=document.getElementById('resume-req-instructions-wrap');w.style.display=w.style.display==='none'?'':'none'})()" class="btn btn-ghost btn-sm" style="font-size:0.75rem;padding:2px 8px;color:var(--text-muted)">✎ Add instructions</button>
            <div id="resume-req-instructions-wrap" style="display:none;margin-top:6px">
              <textarea id="resume-req-instructions" placeholder="e.g. they mentioned being busy this week, keep it very short…" style="width:100%;height:56px;font-size:0.82rem;resize:vertical;border:1px solid var(--border);border-radius:6px;padding:8px"></textarea>
            </div>
          </div>`
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

      ${(hasResume && _modalUser && _modalUser.userType === 'career_consultant') ? `
      <div class="tab-section" style="border:1px solid #c7d2fe;background:#f5f3ff;border-radius:10px;padding:14px">
        <h4 style="margin-top:0">✦ Reposition This Resume</h4>
        <p class="tab-desc">Generate a repositioned version that surfaces their real seniority and impact — your core deliverable. Shows a before/after you can share with the client.</p>
        <button class="btn btn-primary btn-sm" id="rewrite-resume-btn">${c.resumeRewrite ? '↺ Regenerate Repositioned Resume' : '✦ Generate Repositioned Resume'}</button>
        ${c.resumeRewrite ? `<button class="btn btn-secondary btn-sm" id="view-rewrite-btn" style="margin-left:8px">View Before / After</button>` : ''}
        <div id="rewrite-result" style="display:none;margin-top:14px"></div>
      </div>` : ''}

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
      instructionsId: 'resume-req-instructions',
      generate: async (instructions) => {
        const draft = await API.ai.reply(c.id, null, instructions);
        return { draft: draft.draft };
      }
    });
  }

  // Download
  if (hasResume) {
    body.querySelector('#download-resume-btn').addEventListener('click', () => API.candidates.downloadResume(c.id));
  }

  // Resume reposition (consultant) — before/after rewrite
  const rewriteBtn = body.querySelector('#rewrite-resume-btn');
  if (rewriteBtn) {
    const resultEl = body.querySelector('#rewrite-result');
    const renderRewrite = (data) => {
      resultEl.style.display = 'block';
      resultEl.innerHTML = `
        ${data.summary ? `<div style="background:#eef2ff;border-left:3px solid #6366f1;padding:8px 12px;border-radius:6px;font-size:0.85rem;margin-bottom:10px"><strong>What changed:</strong> ${escapeHtml(data.summary)}</div>` : ''}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div>
            <div style="font-size:0.75rem;font-weight:700;color:#64748b;text-transform:uppercase;margin-bottom:4px">Before</div>
            <div style="white-space:pre-wrap;font-size:0.78rem;line-height:1.5;background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:10px;max-height:340px;overflow:auto;color:#475569">${escapeHtml(data.original || (c.resume && c.resume.text) || '')}</div>
          </div>
          <div>
            <div style="font-size:0.75rem;font-weight:700;color:#4338ca;text-transform:uppercase;margin-bottom:4px">After (repositioned)</div>
            <div style="white-space:pre-wrap;font-size:0.78rem;line-height:1.5;background:#fff;border:1px solid #c7d2fe;border-radius:6px;padding:10px;max-height:340px;overflow:auto">${escapeHtml(data.rewritten || '')}</div>
          </div>
        </div>
        <button class="btn btn-secondary btn-xs" id="copy-rewrite-btn" style="margin-top:8px">Copy repositioned text</button>`;
      const copyBtn = resultEl.querySelector('#copy-rewrite-btn');
      if (copyBtn) copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(data.rewritten || '').then(() => Toast.success('Copied'));
      });
    };

    rewriteBtn.addEventListener('click', async () => {
      rewriteBtn.disabled = true; rewriteBtn.textContent = '✦ Repositioning…';
      try {
        const data = await API.ai.rewriteResume(c.id);
        _modalCandidate.resumeRewrite = { rewritten: data.rewritten, summary: data.summary };
        renderRewrite(data);
        if (typeof updateCreditsDisplay === 'function') updateCreditsDisplay(data.creditsRemaining);
      } catch (err) { Toast.error(err.message); }
      finally { rewriteBtn.disabled = false; rewriteBtn.textContent = '↺ Regenerate Repositioned Resume'; }
    });

    const viewBtn = body.querySelector('#view-rewrite-btn');
    if (viewBtn) viewBtn.addEventListener('click', () => {
      renderRewrite({
        original: c.resume && c.resume.text,
        rewritten: c.resumeRewrite.rewritten,
        summary: c.resumeRewrite.summary
      });
    });
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
  const isConsultant = _modalUser && _modalUser.userType === 'career_consultant';
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

  const tabTitle    = isConsultant ? 'Your Honest Assessment' : 'AI Resume Review';
  const tabDesc     = isConsultant
    ? `AI analyses ${escapeHtml(c.name||'their')} resume from your perspective as their coach — what's working, what's not landing on paper, and why it matters. Drafts a warm, expert feedback email that leads naturally into working together.`
    : `AI identifies 3-4 specific, concrete gaps in ${escapeHtml(c.name||'the candidate')}'s resume (referencing actual content). Then drafts a warm email asking if they're open to professional support — <strong>does not mention your resume consultant yet</strong>.`;
  const draftLabel  = isConsultant ? 'Draft — Resume Feedback Email' : 'Draft — Interest Check Email';
  const draftHint   = isConsultant ? 'Your expert assessment — edit before sending' : 'Edit before sending — does not mention your consultant';
  const doneBanner  = isConsultant
    ? '✓ Feedback sent — Proposal tab now available'
    : '✓ Resume review email sent — Intro tab now available';
  const defaultSubj = isConsultant ? `My honest take on your background, ${c.name ? c.name.split(' ')[0] : ''}` : 'Quick thought on your background';

  body.innerHTML = `
    <div class="tab-scroll">
      ${done ? `<div class="step-done-banner">${doneBanner}</div>` : ''}
      <div class="tab-section">
        <h4>${tabTitle}</h4>
        <p class="tab-desc">${tabDesc}</p>
        <button class="btn btn-secondary btn-sm" id="gen-review-btn">✦ ${done ? 'Regenerate' : isConsultant ? 'Write Feedback Email' : 'Run Resume Review'}</button>
        <div style="margin-top:8px">
          <button type="button" onclick="(function(){var w=document.getElementById('review-instructions-wrap');w.style.display=w.style.display==='none'?'':'none'})()" class="btn btn-ghost btn-sm" style="font-size:0.75rem;padding:2px 8px;color:var(--text-muted)">✎ Add instructions</button>
          <div id="review-instructions-wrap" style="display:none;margin-top:6px">
            <textarea id="review-instructions" placeholder="e.g. be more encouraging in tone, focus on their finance background…" style="width:100%;height:56px;font-size:0.82rem;resize:vertical;border:1px solid var(--border);border-radius:6px;padding:8px"></textarea>
          </div>
        </div>
      </div>

      <div id="gaps-display" style="display:none" class="tab-section">
        <div class="gaps-box">
          <h4>${isConsultant ? 'Internal Notes' : 'Identified Gaps'}</h4>
          <div id="gaps-text" class="gaps-content"></div>
        </div>
      </div>

      <div class="draft-area" id="review-draft-area" style="display:none">
        <div class="tab-section">
          <div class="draft-label"><h4>${draftLabel}</h4><span class="text-xs text-muted">${draftHint}</span></div>
          <div class="form-group"><label>Subject Line</label><input type="text" id="review-subject" value="${escapeHtml(defaultSubj)}" /></div>
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
      const reviewInstructions = (body.querySelector('#review-instructions')?.value || '').trim() || undefined;
      const result = await API.ai.resumeReview(c.id, reviewInstructions);
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
    finally {
      const btnLabel = isConsultant ? (done ? 'Regenerate' : 'Write Feedback Email') : (done ? 'Regenerate Review' : 'Run Resume Review');
      btn.disabled = false; btn.textContent = '✦ ' + btnLabel;
    }
  });

  body.querySelector('#review-regen') && body.querySelector('#review-regen').addEventListener('click', () => {
    body.querySelector('#gen-review-btn').click();
  });

  body.querySelector('#review-send') && body.querySelector('#review-send').addEventListener('click', async () => {
    const defaultSubj = isConsultant
      ? `My honest take on your background, ${c.name ? c.name.split(' ')[0] : ''}`
      : 'Quick thought on your background';
    const subject = body.querySelector('#review-subject').value.trim() || defaultSubj;
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
      clearDraft(c.id, 'review-body');
      refreshModal();
      const queuedMsg = queuedSendMessage(result);
      if (queuedMsg) Toast.info(queuedMsg);
      else Toast.success(isConsultant ? 'Feedback sent — Proposal tab is now unlocked' : 'Review email sent — Intro tab is now unlocked');
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
  const isConsultant = _modalUser && _modalUser.userType === 'career_consultant';
  const done = (c.stepsCompleted||{}).victorySent;
  const firstName = c.name ? c.name.split(' ')[0] : 'them';

  if (isConsultant) {
    // ── Proposal tab for career consultants ──────────────────────────────────
    body.innerHTML = `
      <div class="tab-scroll">
        ${done ? `<div class="step-done-banner">✓ Proposal sent</div>` : ''}
        <div class="tab-section">
          <h4>Your Proposal</h4>
          <p class="tab-desc">
            ${escapeHtml(firstName)} has seen your feedback and is interested in working together.
            AI drafts a warm, personal proposal email explaining your process, what they'll gain specific
            to their background, and a low-friction next step — just a reply, no call required.
          </p>
          <button class="btn btn-secondary btn-sm" id="gen-victory-btn">✦ ${done ? 'Regenerate Proposal' : 'Generate Proposal'}</button>
          <div style="margin-top:8px">
            <button type="button" onclick="(function(){var w=document.getElementById('victory-instructions-wrap');w.style.display=w.style.display==='none'?'':'none'})()" class="btn btn-ghost btn-sm" style="font-size:0.75rem;padding:2px 8px;color:var(--text-muted)">✎ Add instructions</button>
            <div id="victory-instructions-wrap" style="display:none;margin-top:6px">
              <textarea id="victory-instructions" placeholder="e.g. emphasize the LinkedIn rewrite deliverable, keep it under 200 words…" style="width:100%;height:56px;font-size:0.82rem;resize:vertical;border:1px solid var(--border);border-radius:6px;padding:8px"></textarea>
            </div>
          </div>
        </div>
        <div class="draft-area" id="victory-draft-area" style="display:none">
          <div class="tab-section">
            <div class="draft-label"><h4>Draft — Proposal Email</h4><span class="text-xs text-muted">Edit before sending</span></div>
            <div class="form-group"><label>Subject Line</label><input type="text" id="victory-subject" value="What working together would look like, ${escapeHtml(firstName)}" /></div>
            <div class="form-group"><label>Message</label><textarea id="victory-body" class="draft-textarea" style="min-height:260px"></textarea></div>
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
      defaultSubject: `What working together would look like, ${firstName}`,
      stepKey: 'victorySent',
      stageTo: null,
      instructionsId: 'victory-instructions',
      generate: (instructions) => API.ai.proposal(c.id, instructions)
    });
    return;
  }

  // ── Victory / Introduction tab for recruiters ─────────────────────────────
  const partnerName  = (_modalUser && _modalUser.resumeConsultantName)  || '';
  const partnerEmail = (_modalUser && _modalUser.resumeConsultantEmail) || '';
  const hasPartner   = partnerName.length > 0;

  const partnerBanner = !hasPartner
    ? `<div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:0.82rem;color:#92400e">
        <strong>No resume consultant configured.</strong>
        Add your partner's name and email in <strong>Settings → Account → Resume Consultant Partner</strong>
        so the introduction email uses the right name and CC address.
       </div>`
    : `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:8px 14px;margin-bottom:14px;font-size:0.82rem;color:#14532d">
        Introducing to <strong>${escapeHtml(partnerName)}</strong>${partnerEmail ? ` · CC: ${escapeHtml(partnerEmail)}` : ''}
       </div>`;

  body.innerHTML = `
    <div class="tab-scroll">
      ${done ? `<div class="step-done-banner">✓ Introduction sent to ${escapeHtml(partnerName || 'your consultant')}</div>` : ''}
      <div class="tab-section">
        <h4>Resume Consultant Introduction</h4>
        ${partnerBanner}
        <p class="tab-desc">AI drafts a warm introduction email addressed to ${escapeHtml(firstName)} and CC'd to your resume consultant. The email summarises the candidate's background, highlights why their resume needs stronger positioning, and hands them off — feels like a genuine recommendation, not a sales pitch.</p>
        <button class="btn btn-secondary btn-sm" id="gen-victory-btn">✦ ${done ? 'Regenerate Introduction' : 'Generate Introduction Email'}</button>
        <div style="margin-top:8px">
          <button type="button" onclick="(function(){var w=document.getElementById('victory-instructions-wrap');w.style.display=w.style.display==='none'?'':'none'})()" class="btn btn-ghost btn-sm" style="font-size:0.75rem;padding:2px 8px;color:var(--text-muted)">✎ Add instructions</button>
          <div id="victory-instructions-wrap" style="display:none;margin-top:6px">
            <textarea id="victory-instructions" placeholder="e.g. mention they're a strong fit for VP-level roles, add urgency…" style="width:100%;height:56px;font-size:0.82rem;resize:vertical;border:1px solid var(--border);border-radius:6px;padding:8px"></textarea>
          </div>
        </div>
      </div>
      <div class="draft-area" id="victory-draft-area" style="display:none">
        <div class="tab-section">
          <div class="draft-label"><h4>Draft — Introduction Email</h4><span class="text-xs text-muted">Edit before sending</span></div>
          ${partnerEmail ? `<p style="font-size:0.78rem;color:#14532d;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:6px 12px;margin:0 0 10px;display:inline-block">✓ Will CC <strong>${escapeHtml(partnerEmail)}</strong> automatically</p>` : ''}
          <div class="form-group"><label>Subject Line</label><input type="text" id="victory-subject" value="Someone I think you should connect with, ${escapeHtml(firstName)}" /></div>
          <div class="form-group"><label>Message</label><textarea id="victory-body" class="draft-textarea" style="min-height:260px"></textarea></div>
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
    defaultSubject: `Someone I think you should connect with, ${firstName}`,
    stepKey: 'victorySent',
    stageTo: null,
    cc: partnerEmail || null,
    instructionsId: 'victory-instructions',
    generate: (instructions) => API.ai.victory(c.id, instructions)
  });
}

// ================================================================
// TAB 7: THREAD
// ================================================================

function renderThreadTab(body) {
  const c = _modalCandidate;
  const thread = c.thread || [];

  const toBr   = s => escapeHtml(s).replace(/\n/g, '<br>');
  const threadHtml = thread.length === 0
    ? `<div class="thread-empty">No messages yet. Send an outreach to start the conversation.</div>`
    : thread.map((msg, i) => {
        const full = msg.body || '';
        const isHtml = looksLikeHtml(full);

        let visibleHtml, fullHtml, trimmed;
        if (isHtml) {
          const stripped = msg.direction === 'inbound' ? stripHtmlQuotes(full) : { html: full, trimmed: false };
          visibleHtml = stripped.html;
          fullHtml    = full;
          trimmed     = stripped.trimmed;
        } else {
          const visibleTxt = msg.direction === 'inbound' ? stripQuotedText(full) : full;
          visibleHtml = toBr(visibleTxt);
          fullHtml    = toBr(full);
          trimmed     = visibleTxt.length < full.length;
        }

        return `
      <div class="thread-msg ${msg.direction||'outbound'}">
        <div class="thread-msg-header">
          <span class="thread-direction">${msg.direction === 'inbound' ? `↙ ${escapeHtml(c.name||'Candidate')}` : '↗ You'}</span>
          <span class="thread-time">${formatRelative(msg.timestamp)}</span>
        </div>
        ${msg.subject ? `<div class="thread-subject">${escapeHtml(msg.subject)}</div>` : ''}
        <div class="thread-body">${visibleHtml}</div>
        ${trimmed ? `
          <button class="thread-quote-toggle" data-qi="${i}" style="background:none;border:none;color:var(--text-muted);font-size:0.74rem;cursor:pointer;padding:4px 0;margin-top:2px">··· show quoted text</button>
          <div class="thread-quoted" data-qi="${i}" style="display:none;border-left:2px solid var(--border);padding-left:10px;margin-top:6px;color:var(--text-muted);font-size:0.82rem">${fullHtml}</div>
        ` : ''}
      </div>`;
      }).join('');

  const isConsultantThread = _modalUser && _modalUser.userType === 'career_consultant';

  body.innerHTML = `
    <div class="thread-container">
      <div class="thread-messages" id="thread-msgs">${threadHtml}</div>

      ${c.pendingFollowUpDraft ? `
        <div id="pending-draft-banner" style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:#ecfeff;border:1px solid #a5f3fc;border-radius:9px;margin:0 16px 10px;font-size:0.82rem;color:#155e75">
          <span>✍️</span>
          <span style="flex:1">A follow-up draft is ready — auto-generated after ${c.pendingFollowUpDraft.kind === 'review' ? 'the resume review' : 'the consultant intro'} went unanswered. Review before sending.</span>
          <button class="btn btn-primary btn-sm" id="load-pending-draft-btn">Load into compose</button>
          <button class="btn btn-ghost btn-sm" id="dismiss-pending-draft-btn">Dismiss</button>
        </div>` : ''}
      <div class="compose-area">
        <div class="compose-header">
          <h4>Compose</h4>
          <div class="compose-ai-btns">
            <button class="btn btn-ghost btn-sm" id="th-gen-reply">✦ Draft Reply</button>
            <button class="btn btn-ghost btn-sm" id="th-gen-outreach">✦ Outreach</button>
            <button class="btn btn-ghost btn-sm" id="th-gen-followup" title="Draft a follow-up on this conversation">✦ Draft Follow Up</button>
            <button class="btn btn-ghost btn-sm" id="th-set-followup" title="Set a reminder to follow up later">⏰ Remind me</button>
          </div>
        </div>
        <div id="th-instructions-row" style="margin-bottom:6px">
          <button onclick="(function(){var w=document.getElementById('th-instructions-wrap');w.style.display=w.style.display==='none'?'':'none'})()" class="btn btn-ghost btn-sm" style="font-size:0.75rem;padding:2px 8px;color:var(--text-muted)">✎ Add instructions</button>
          <div id="th-instructions-wrap" style="display:none;margin-top:6px">
            <textarea id="th-instructions" placeholder="e.g. mention our relocation package, keep it under 3 sentences, more formal tone…" style="width:100%;height:56px;font-size:0.82rem;resize:vertical"></textarea>
          </div>
        </div>
        <div class="form-group" style="margin-bottom:8px">
          <input type="text" id="th-subject" placeholder="Subject line…" value="${escapeHtml(c.lastSubject ? 'Re: ' + c.lastSubject.replace(/^Re:\s*/i,'') : '')}" />
        </div>
        <textarea id="th-body" class="compose-textarea" placeholder="Type your message…"></textarea>
        <div id="th-deliverability" style="display:none;margin:8px 0;font-size:0.8rem"></div>
        <div class="compose-footer">
          <span class="text-xs text-muted">All sends require your approval above</span>
          <button class="btn btn-ghost btn-sm" id="th-check-deliver" title="Check spam/deliverability risk">🛡 Check deliverability</button>
          <span style="position:relative;display:inline-flex">
            <button class="btn btn-primary" id="th-send" style="border-top-right-radius:0;border-bottom-right-radius:0">Send Email</button>
            <button class="btn btn-primary" id="th-schedule-btn" title="Schedule send for later" style="border-top-left-radius:0;border-bottom-left-radius:0;border-left:1px solid rgba(255,255,255,0.3);padding-left:10px;padding-right:10px">🕐 ▾</button>
            <div id="th-schedule-menu" style="display:none;position:absolute;bottom:calc(100% + 6px);right:0;background:var(--card-bg);border:1px solid var(--border);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.22);padding:6px;min-width:220px;z-index:60">
              <div style="font-size:0.68rem;font-weight:600;color:var(--text-muted);letter-spacing:0.08em;text-transform:uppercase;padding:4px 8px 6px">Send later</div>
              <button class="btn btn-ghost btn-sm th-sched-preset" data-mins="15" style="width:100%;justify-content:flex-start">In 15 minutes</button>
              <button class="btn btn-ghost btn-sm th-sched-preset" data-mins="60" style="width:100%;justify-content:flex-start">In 1 hour</button>
              <button class="btn btn-ghost btn-sm th-sched-preset" data-mins="180" style="width:100%;justify-content:flex-start">In 3 hours</button>
              <button class="btn btn-ghost btn-sm" id="th-sched-tomorrow" style="width:100%;justify-content:flex-start">Tomorrow 9:00 AM</button>
              <div style="border-top:1px solid var(--border);margin:6px 0;padding:8px 8px 4px">
                <input type="datetime-local" id="th-sched-custom" style="width:100%;font-size:0.8rem;margin-bottom:6px" />
                <button class="btn btn-secondary btn-sm" id="th-sched-custom-go" style="width:100%">Schedule</button>
              </div>
            </div>
          </span>
        </div>
      </div>
    </div>
  `;

  // Scroll thread to bottom
  const msgsEl = body.querySelector('#thread-msgs');
  if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;

  // ── Draft auto-save / restore ─────────────────────────────────────────────
  const draftKey     = `recruit_draft_${c.id}_thread`;
  const draftSubjKey = `recruit_draft_${c.id}_thread_subj`;
  const bodyEl  = body.querySelector('#th-body');
  const subjEl  = body.querySelector('#th-subject');
  const saved = localStorage.getItem(draftKey);
  const savedSubj = localStorage.getItem(draftSubjKey);
  if (saved)     { bodyEl.value = saved; }
  if (savedSubj && !subjEl.value) { subjEl.value = savedSubj; }
  if (saved) {
    const badge = document.createElement('span');
    badge.textContent = '• Draft restored';
    badge.style.cssText = 'font-size:0.73rem;color:#d97706;margin-left:8px';
    subjEl.parentElement.appendChild(badge);
    setTimeout(() => badge.remove(), 4000);
  }
  bodyEl.addEventListener('input', () => localStorage.setItem(draftKey, bodyEl.value));
  subjEl.addEventListener('input', () => localStorage.setItem(draftSubjKey, subjEl.value));

  // Quoted-text toggles
  body.querySelectorAll('.thread-quote-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const block = body.querySelector(`.thread-quoted[data-qi="${btn.dataset.qi}"]`);
      if (!block) return;
      const show = block.style.display === 'none';
      block.style.display = show ? 'block' : 'none';
      btn.textContent = show ? '··· hide quoted text' : '··· show quoted text';
    });
  });

  // AI buttons
  // Tracks which draft type was last generated into the compose box, so Send
  // can tag the outbound message as a follow-up for reporting (isFollowUp).
  // Stays set through minor manual edits (typos, personalization) — only a
  // fresh generate() call of a different type changes it.
  let lastGeneratedType = null;

  async function aiGenerate(type) {
    const btn = body.querySelector(`#th-gen-${type}`);
    const origText = btn.textContent;
    btn.disabled = true; btn.textContent = '…';
    const instructions = (body.querySelector('#th-instructions')?.value || '').trim();
    try {
      let result;
      if (type === 'reply') {
        const lastInbound = [...thread].reverse().find(m => m.direction === 'inbound');
        result = await API.ai.reply(c.id, lastInbound ? stripQuotedText(lastInbound.body) : null, instructions);
      } else if (type === 'outreach') {
        result = await API.ai.outreach(c.id, instructions);
      } else if (type === 'jd') {
        result = await API.ai.roleJD(c.id);
      } else if (type === 'followup') {
        result = await API.ai.followup(c.id, instructions);
      }
      if (result && result.draft) {
        body.querySelector('#th-body').value = result.draft;
        lastGeneratedType = type;
        if (type === 'outreach' && !body.querySelector('#th-subject').value) {
          const firstName = c.name ? c.name.split(' ')[0] : 'there';
          body.querySelector('#th-subject').value = isConsultantThread
            ? `A quick thought on your next move, ${firstName}`
            : `Something Worth a Few Minutes of Your Time, ${firstName}`;
        }
        body.querySelector('#th-body').focus();
      }
    } catch (err) { Toast.error(err.message); }
    finally { btn.disabled = false; btn.textContent = origText; }
  }

  body.querySelector('#th-gen-reply').addEventListener('click', () => aiGenerate('reply'));
  body.querySelector('#th-gen-outreach').addEventListener('click', () => aiGenerate('outreach'));
  body.querySelector('#th-gen-followup').addEventListener('click', () => aiGenerate('followup'));

  // Pending follow-up draft (auto-generated after review/victory stage went
  // quiet) — load it into compose for the recruiter to review before sending.
  const loadDraftBtn = body.querySelector('#load-pending-draft-btn');
  if (loadDraftBtn) {
    loadDraftBtn.addEventListener('click', () => {
      const d = c.pendingFollowUpDraft;
      if (!d) return;
      body.querySelector('#th-subject').value = d.subject || '';
      body.querySelector('#th-body').value = d.body || '';
      lastGeneratedType = null;
      body.querySelector('#th-body').focus();
      Toast.show('Draft loaded — review, then Send Email');
    });
  }
  const dismissDraftBtn = body.querySelector('#dismiss-pending-draft-btn');
  if (dismissDraftBtn) {
    dismissDraftBtn.addEventListener('click', async () => {
      dismissDraftBtn.disabled = true;
      try {
        const updated = await API.candidates.update(c.id, { pendingFollowUpDraft: null });
        Object.assign(_modalCandidate, updated);
        _modalOnUpdate(_modalCandidate);
        renderThreadTab(body);
      } catch (err) { Toast.error(err.message); dismissDraftBtn.disabled = false; }
    });
  }

  // Follow Up — inline date picker injected below the button
  body.querySelector('#th-set-followup').addEventListener('click', function() {
    const existing = body.querySelector('#th-followup-picker');
    if (existing) { existing.remove(); return; }

    const today = new Date();
    const defaultDate = new Date(today);
    defaultDate.setDate(today.getDate() + 3);
    const iso = defaultDate.toISOString().slice(0, 10);

    const picker = document.createElement('div');
    picker.id = 'th-followup-picker';
    picker.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 16px;background:var(--surface2);border-top:1px solid var(--border);flex-wrap:wrap';
    picker.innerHTML = `
      <label style="font-size:0.8rem;color:var(--text-mid);white-space:nowrap">Remind me on:</label>
      <input type="date" id="th-followup-date" value="${iso}" style="font-size:0.82rem;padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)" />
      <button class="btn btn-primary btn-xs" id="th-followup-save">Set Reminder</button>
      <button class="btn btn-secondary btn-xs" id="th-followup-clear">Clear</button>
    `;
    // Insert after compose-header
    const header = body.querySelector('.compose-header');
    header.insertAdjacentElement('afterend', picker);

    picker.querySelector('#th-followup-save').addEventListener('click', async () => {
      const dateVal = picker.querySelector('#th-followup-date').value;
      if (!dateVal) return;
      try {
        await API.candidates.update(c.id, { followUpDate: new Date(dateVal).toISOString() });
        c.followUpDate = new Date(dateVal).toISOString();
        Toast.success('Follow-up reminder set for ' + new Date(dateVal).toLocaleDateString());
        picker.remove();
      } catch (err) { Toast.error(err.message); }
    });

    picker.querySelector('#th-followup-clear').addEventListener('click', async () => {
      try {
        await API.candidates.update(c.id, { followUpDate: null });
        c.followUpDate = null;
        Toast.show('Follow-up reminder cleared');
        picker.remove();
      } catch (err) { Toast.error(err.message); }
    });
  });

  // Deliverability lint (instant, no API cost)
  body.querySelector('#th-check-deliver').addEventListener('click', async () => {
    const subject = body.querySelector('#th-subject').value.trim();
    const msgBody = body.querySelector('#th-body').value.trim();
    const out = body.querySelector('#th-deliverability');
    if (!msgBody) { Toast.warning('Write a message first'); return; }
    out.style.display = 'block';
    out.innerHTML = 'Checking…';
    try {
      const r = await API.email.analyzeDraft(subject, msgBody);
      const col = r.score >= 85 ? '#16a34a' : r.score >= 70 ? '#d97706' : '#ef4444';
      const iconFor = lv => lv === 'ok' ? '✓' : lv === 'info' ? 'ℹ' : '⚠';
      out.innerHTML = `
        <div style="border:1px solid ${col}40;background:${col}10;border-radius:8px;padding:10px 12px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="font-weight:700;color:${col};font-size:1.1rem">${r.score}/100</span>
            <span style="font-weight:600;color:${col}">${r.grade}</span>
            <span style="color:var(--text-muted);font-size:0.75rem;margin-left:auto">${r.words} words · ${r.links} link(s)</span>
          </div>
          ${r.issues.map(i => `<div style="font-size:0.78rem;color:${i.level==='warn'?'#b45309':i.level==='ok'?'#15803d':'#64748b'};padding:1px 0">${iconFor(i.level)} ${escapeHtml(i.msg)}</div>`).join('')}
        </div>`;
    } catch (err) { out.innerHTML = `<span style="color:#ef4444">${escapeHtml(err.message)}</span>`; }
  });

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
      const result = await API.email.send({ candidateId: c.id, subject, body: msgBody, isReply, isFollowUp: lastGeneratedType === 'followup' });
      if (result.candidate) Object.assign(_modalCandidate, result.candidate);
      _modalOnUpdate(_modalCandidate);
      clearDraft(c.id, 'thread');
      clearDraft(c.id, 'thread_subj');
      const queuedMsg = queuedSendMessage(result);
      if (queuedMsg) Toast.info(queuedMsg);
      else Toast.success('Email sent');
      renderThreadTab(body);
    } catch (err) {
      if (typeof handleReauthError === 'function' && handleReauthError(err)) { /* handled */ }
      else Toast.error(err.message);
    }
    finally { btn.disabled = false; btn.textContent = 'Send Email'; }
  });

  // ── Schedule send ─────────────────────────────────────────────────────────
  const schedMenu = body.querySelector('#th-schedule-menu');
  const schedToggle = body.querySelector('#th-schedule-btn');
  const fmtWhen = d => d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  schedToggle.addEventListener('click', () => {
    const show = schedMenu.style.display === 'none';
    schedMenu.style.display = show ? 'block' : 'none';
    if (show) {
      // Prefill custom picker with +1h, rounded to the next quarter hour
      const d = new Date(Date.now() + 60 * 60 * 1000);
      d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
      const pad = n => String(n).padStart(2, '0');
      body.querySelector('#th-sched-custom').value =
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  });

  async function scheduleSend(when) {
    const subject = body.querySelector('#th-subject').value.trim();
    const msgBody = body.querySelector('#th-body').value.trim();
    if (!subject) { Toast.warning('Subject line required'); return; }
    if (!msgBody) { Toast.warning('Message body is empty'); return; }
    if (when.getTime() <= Date.now()) { Toast.warning('Pick a time in the future'); return; }
    schedMenu.style.display = 'none';
    schedToggle.disabled = true;
    try {
      const isReply = thread.some(m => m.direction === 'outbound');
      await API.email.send({ candidateId: c.id, subject, body: msgBody, isReply, isFollowUp: lastGeneratedType === 'followup', scheduledAt: when.toISOString() });
      clearDraft(c.id, 'thread');
      clearDraft(c.id, 'thread_subj');
      Toast.success(`Scheduled for ${fmtWhen(when)}`);
      renderThreadTab(body);
    } catch (err) {
      if (typeof handleReauthError === 'function' && handleReauthError(err)) { /* handled */ }
      else Toast.error(err.message);
    }
    finally { schedToggle.disabled = false; }
  }

  body.querySelectorAll('.th-sched-preset').forEach(b => {
    b.addEventListener('click', () => scheduleSend(new Date(Date.now() + parseInt(b.dataset.mins, 10) * 60 * 1000)));
  });
  body.querySelector('#th-sched-tomorrow').addEventListener('click', () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    scheduleSend(d);
  });
  body.querySelector('#th-sched-custom-go').addEventListener('click', () => {
    const v = body.querySelector('#th-sched-custom').value;
    if (!v) { Toast.warning('Pick a date and time'); return; }
    scheduleSend(new Date(v));
  });

  // ── Pending scheduled sends — banner with cancel ─────────────────────────
  API.email.scheduled(c.id).then(({ jobs }) => {
    if (!jobs || !jobs.length) return;
    const msgsEl2 = body.querySelector('#thread-msgs');
    if (!msgsEl2) return;
    jobs.forEach(job => {
      const div = document.createElement('div');
      div.className = 'sched-banner';
      div.style.cssText = 'margin:8px 16px;padding:10px 14px;border:1px dashed var(--border);border-radius:10px;background:var(--card-bg);display:flex;align-items:center;gap:10px;font-size:0.82rem';
      div.innerHTML = `
        <span style="font-size:1rem">🕐</span>
        <span style="flex:1;min-width:0">
          <strong>Scheduled</strong> — sends ${escapeHtml(fmtWhen(new Date(job.scheduledAt)))}<br>
          <span style="color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block">${escapeHtml(job.subject)}</span>
        </span>
        <button class="btn btn-secondary btn-sm">Cancel</button>`;
      div.querySelector('button').addEventListener('click', async () => {
        try {
          await API.email.cancelScheduled(job.id);
          // Restore the draft into the compose fields so it isn't lost
          body.querySelector('#th-subject').value = job.subject;
          const bodyField = body.querySelector('#th-body');
          bodyField.value = job.body;
          bodyField.dispatchEvent(new Event('input'));
          div.remove();
          Toast.success('Scheduled send cancelled — draft restored below');
        } catch (err) { Toast.error(err.message); }
      });
      msgsEl2.insertAdjacentElement('afterend', div);
    });
  }).catch(() => {});
}

// ================================================================
// SHARED: AI Draft Wire-up
// ================================================================

function wireAIDraft(body, { genBtnId, draftAreaId, subjectId, bodyId, regenBtnId, sendBtnId, defaultSubject, stepKey, stageTo, cc, instructionsId, generate, onGenerated, extraSendParams }) {
  const c = _modalCandidate;

  const genBtn = body.querySelector('#' + genBtnId);
  const draftArea = body.querySelector('#' + draftAreaId);
  if (!genBtn || !draftArea) return;

  // Wire up subject input for draft persistence (not covered by initDraftTextareas)
  if (subjectId) {
    const subjectEl = body.querySelector('#' + subjectId);
    if (subjectEl) {
      const subjectKey = draftStorageKey(c.id, subjectId);
      const savedSubject = localStorage.getItem(subjectKey);
      if (savedSubject && !subjectEl.value) subjectEl.value = savedSubject;
      subjectEl.addEventListener('input', () => localStorage.setItem(subjectKey, subjectEl.value));
    }
  }

  async function doGenerate() {
    const orig = genBtn.textContent;
    genBtn.disabled = true; genBtn.textContent = '✦ Generating…';
    try {
      const instructionsEl = instructionsId ? body.querySelector('#' + instructionsId) : null;
      const instructions = (instructionsEl?.value || '').trim() || undefined;
      const result = await generate(instructions);
      const draft = result.draft || result.text || result;
      const subjectEl = body.querySelector('#' + subjectId);
      const bodyEl = body.querySelector('#' + bodyId);
      if (bodyEl) {
        bodyEl.value = typeof draft === 'string' ? draft : JSON.stringify(draft);
        bodyEl.dispatchEvent(new Event('input'));
      }
      if (subjectEl) {
        subjectEl.value = (result.subject && result.subject.trim()) || subjectEl.value || defaultSubject;
        subjectEl.dispatchEvent(new Event('input'));
      }
      if (onGenerated) onGenerated(result);
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
        const extra = extraSendParams ? extraSendParams() : {};
        const result = await API.email.send({ candidateId: c.id, subject, body: msgBody, isReply, ...(cc ? { cc } : {}), ...extra });
        if (result.candidate) Object.assign(_modalCandidate, result.candidate);

        // Mark step complete
        const stepsUpdate = { stepsCompleted: { ...(c.stepsCompleted||{}), [stepKey]: true } };
        if (stageTo) stepsUpdate.stage = stageTo;
        const updated = await API.candidates.update(c.id, stepsUpdate);
        Object.assign(_modalCandidate, updated);
        _modalOnUpdate(_modalCandidate);
        clearDraft(c.id, bodyId);
        if (subjectId) clearDraft(c.id, subjectId);
        refreshModal();
        const queuedMsg = queuedSendMessage(result);
        if (queuedMsg) Toast.info(queuedMsg);
        else Toast.success('Email sent');
        renderModalTab(_activeTab);
      } catch (err) { Toast.error(err.message); }
      finally { sendBtn.disabled = false; sendBtn.textContent = 'Approve & Send'; }
    });
  }
}
