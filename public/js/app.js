/* ============================================================
   Welltower Recruiter — Main Application
   ============================================================ */

let currentUser = null;
let allCandidates = [];
let currentView = 'pipeline';
let currentFilter = { stage: '', search: '', dateRange: '', customDate: '' };

// Handle token-expired errors — show a reconnect banner and mark Gmail as disconnected locally
function handleReauthError(err) {
  if (!err || !err.reauth) return false;
  if (err.reauth === 'gmail') {
    // Mark local user state as disconnected so UI reflects it
    if (currentUser && currentUser.gmail) currentUser.gmail.connected = false;
    Toast.error('⚠️ Gmail disconnected — token expired. Go to Settings → Email and reconnect Gmail.');
    // Flash the settings button to draw attention
    const settingsBtn = document.querySelector('[data-view="settings"]');
    if (settingsBtn) {
      settingsBtn.style.outline = '2px solid #ef4444';
      setTimeout(() => { settingsBtn.style.outline = ''; }, 4000);
    }
  }
  return true;
}

// ---- Boot ----
document.addEventListener('DOMContentLoaded', async () => {
  // Dark mode
  applyTheme(localStorage.getItem('theme') || 'light');

  try {
    currentUser = await API.auth.me();
    if (!currentUser) { window.location.href = '/login'; return; }
  } catch {
    window.location.href = '/login';
    return;
  }

  // Gmail OAuth result
  const params = new URLSearchParams(window.location.search);
  if (params.get('gmail') === 'connected') {
    Toast.success('Gmail connected successfully!');
    window.history.replaceState({}, '', '/dashboard');
    currentUser = await API.auth.me();
  } else if (params.get('gmail') === 'error') {
    Toast.error('Gmail connection failed: ' + (params.get('reason') || 'Unknown error'));
    window.history.replaceState({}, '', '/dashboard');
  } else if (params.get('zoho') === 'connected') {
    Toast.success('Zoho Mail connected successfully!');
    window.history.replaceState({}, '', '/dashboard');
    currentUser = await API.auth.me();
  } else if (params.get('zoho') === 'error') {
    Toast.error('Zoho connection failed: ' + (params.get('reason') || 'Unknown error'));
    window.history.replaceState({}, '', '/dashboard');
  } else if (params.get('outlook') === 'connected') {
    Toast.success('Outlook connected successfully!');
    window.history.replaceState({}, '', '/dashboard');
    currentUser = await API.auth.me();
  } else if (params.get('outlook') === 'error') {
    Toast.error('Outlook connection failed: ' + (params.get('reason') || 'Unknown error'));
    window.history.replaceState({}, '', '/dashboard');
  }

  document.getElementById('sidebar-user-name').textContent = currentUser.name;
  document.getElementById('sidebar-user-email').textContent = currentUser.email;

  // Email reconnect banner — show if the Gmail token expired
  initReauthBanner();

  // Credits display
  updateCreditsDisplay(currentUser.credits);

  // Admin link
  if (currentUser.isAdmin) {
    const adminLink = document.getElementById('admin-nav-link');
    if (adminLink) adminLink.classList.remove('hidden');
  }

  // Show the user's company name in the sidebar (falls back to "Recruit Pro")
  const _sidebarName = document.getElementById('sidebar-company-name');
  if (_sidebarName && currentUser.companyName) _sidebarName.textContent = currentUser.companyName;

  // Nav
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      navigateTo(item.dataset.page);
      if (item.dataset.page === 'analytics')  loadAnalyticsPage();
      if (item.dataset.page === 'followups')  loadFollowUpPage();
      if (item.dataset.page === 'hotleads')   loadHotLeadsPage();
      if (item.dataset.page === 'templates')  loadTemplatesPage();
    });
  });

  // Logout
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await API.auth.logout();
    window.location.href = '/login';
  });

  // Dark mode toggle
  document.getElementById('dark-toggle-btn').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });

  // View toggle
  document.getElementById('view-pipeline-btn').addEventListener('click', () => switchView('pipeline'));
  document.getElementById('view-list-btn').addEventListener('click', () => switchView('list'));

  // Search
  document.getElementById('search-input').addEventListener('input', e => {
    currentFilter.search = e.target.value.toLowerCase().trim();
    renderCandidates();
  });

  // Stage filter
  document.getElementById('stage-filter').addEventListener('change', e => {
    currentFilter.stage = e.target.value;
    renderCandidates();
  });

  // Date filter (by recent activity)
  document.getElementById('date-filter').addEventListener('change', e => {
    currentFilter.dateRange = e.target.value;
    const custom = document.getElementById('date-filter-custom');
    custom.style.display = e.target.value === 'custom' ? '' : 'none';
    if (e.target.value !== 'custom') { currentFilter.customDate = ''; custom.value = ''; }
    renderCandidates();
  });
  document.getElementById('date-filter-custom').addEventListener('change', e => {
    currentFilter.customDate = e.target.value;
    renderCandidates();
  });

  // Import CSV
  document.getElementById('import-btn').addEventListener('click', () => new Modal('import-modal').open());
  document.getElementById('import-cancel-btn').addEventListener('click', () => new Modal('import-modal').close());
  document.getElementById('import-submit-btn').addEventListener('click', handleImport);
  document.getElementById('import-modal').querySelector('.modal-close').addEventListener('click', () => new Modal('import-modal').close());

  // Add candidate
  document.getElementById('add-candidate-btn').addEventListener('click', () => new Modal('add-candidate-modal').open());
  document.getElementById('add-cancel-btn').addEventListener('click', () => new Modal('add-candidate-modal').close());
  document.getElementById('add-candidate-submit-btn').addEventListener('click', handleAddCandidate);
  document.getElementById('add-candidate-modal').querySelector('.modal-close').addEventListener('click', () => new Modal('add-candidate-modal').close());

  // Fetch emails
  document.getElementById('fetch-email-btn').addEventListener('click', handleFetchEmails);

  // Bulk stage
  document.getElementById('bulk-stage-btn').addEventListener('click', handleBulkStage);

  // Export CSV
  document.getElementById('export-csv-btn').addEventListener('click', exportCSV);

  // Bulk outreach
  document.getElementById('bulk-outreach-btn').addEventListener('click', openBulkOutreachModal);
  document.getElementById('bulk-outreach-cancel-btn').addEventListener('click', () => new Modal('bulk-outreach-modal').close());
  document.getElementById('bulk-outreach-modal').querySelector('.modal-close').addEventListener('click', () => new Modal('bulk-outreach-modal').close());
  document.getElementById('bulk-outreach-start-btn').addEventListener('click', handleBulkOutreach);

  // Settings page
  initSettingsPage();

  // Templates page
  wireTemplateEditor();

  // LinkedIn import modal
  wireLinkedInImport();

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    const active = document.activeElement;
    const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT');
    if (!isInput && e.key === 'n') {
      e.preventDefault();
      new Modal('add-candidate-modal').open();
    }
    if (e.key === 'Escape') {
      closeCandidateModal();
    }
  });

  // Live local clock in the sidebar
  startSidebarClock();

  // Record the user's real browser timezone (used for autopilot send windows).
  // Fire-and-forget; only matters for scheduling accuracy.
  try {
    const tzOffset = -new Date().getTimezoneOffset() / 60;
    if (!currentUser || currentUser.tzOffset !== tzOffset) {
      API.settings.update({ tzOffset }).catch(() => {});
    }
  } catch {}

  // Analytics refresh button
  document.getElementById('refresh-analytics-btn').addEventListener('click', loadAnalyticsPage);

  // Today refresh button
  const todayRefresh = document.getElementById('today-refresh-btn');
  if (todayRefresh) todayRefresh.addEventListener('click', loadTodayPage);

  // Follow-up filter option (injected dynamically)
  const stageFilter = document.getElementById('stage-filter');
  const fuOpt = document.createElement('option');
  fuOpt.value = '__followup__'; fuOpt.textContent = '⏰ Follow-Up Due';
  stageFilter.appendChild(fuOpt);

  // Load candidates
  await loadCandidates();

  // Check for bookmarklet import token in URL (?li=TOKEN)
  const liToken = params.get('li');
  if (liToken) {
    window.history.replaceState({}, '', '/dashboard');
    navigateTo('candidates');
    handleBookmarkletImport(liToken);
  } else {
    navigateTo('today');
  }

  // Generate the bookmarklet href using this app's origin
  buildBookmarkletLink();

  // Register for push notifications (asks permission, no-op if not supported or denied)
  registerPushNotifications();

  // Auto-refresh every 2 minutes — detect new opens and show toast
  setInterval(async () => {
    const previousOpened = new Set(allCandidates.filter(c => c.opened).map(c => c.id));
    const previousUnread = new Set(allCandidates.filter(c => c.unread).map(c => c.id));
    try {
      const fresh = await API.candidates.list();
      const newOpens = fresh.filter(c => c.opened && !previousOpened.has(c.id));
      const newReplies = fresh.filter(c => c.unread && !previousUnread.has(c.id));
      if (newOpens.length) Toast.show(`📬 ${newOpens.map(c=>c.name).join(', ')} opened your email`);
      if (newReplies.length) Toast.success(`💬 ${newReplies.length} new repl${newReplies.length===1?'y':'ies'} received`);
      allCandidates = fresh;
      renderCandidates();
      updateUnreadBadge();
      updateFollowUpBadge();
    } catch { /* silent */ }
  }, 2 * 60 * 1000);
});

// Refresh the sidebar credit balance. Accepts cents; falls back to currentUser.
function updateCreditsDisplay(cents) {
  if (cents !== undefined && cents !== null && currentUser) currentUser.credits = cents;
  const creditsEl  = document.getElementById('sidebar-credits');
  const creditsVal = document.getElementById('sidebar-credits-val');
  if (creditsEl && creditsVal) {
    creditsEl.style.display = 'block';
    const bal = ((currentUser && currentUser.credits) || 0) / 100;
    creditsVal.textContent = `$${bal.toFixed(2)}`;
    creditsVal.style.color = bal <= 0 ? '#f87171' : bal < 0.50 ? '#fbbf24' : '#86efac';
  }
}

// ---- Theme ----
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  const btn = document.getElementById('dark-toggle-btn');
  if (btn) btn.textContent = theme === 'dark' ? '☀' : '☽';
}

// ---- Navigation ----
function navigateTo(page) {
  document.querySelectorAll('.nav-item').forEach(i => i.classList.toggle('active', i.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `page-${page}`));
  if (page === 'today')     loadTodayPage();
  if (page === 'settings')  loadSettingsPage();
  if (page === 'followups') loadFollowUpPage();
  if (page === 'hotleads')  loadHotLeadsPage();
  if (page === 'templates') loadTemplatesPage();
}

// ---- View switching ----
function switchView(view) {
  currentView = view;
  document.getElementById('view-pipeline-btn').classList.toggle('active', view === 'pipeline');
  document.getElementById('view-list-btn').classList.toggle('active', view === 'list');
  document.getElementById('pipeline-view').classList.toggle('hidden', view !== 'pipeline');
  document.getElementById('list-view-wrapper').classList.toggle('hidden', view !== 'list');
  renderCandidates();
}

// ---- Load & render ----
async function loadCandidates() {
  try {
    allCandidates = await API.candidates.list();
    renderCandidates();
    renderTagFilterBar();
    updateUnreadBadge();
    updateFollowUpBadge();
    updateHotLeadsBadge();
  } catch (err) {
    Toast.error('Failed to load candidates: ' + err.message);
  }
}

// Currently active tag filter (null = all)
let currentTagFilter = null;

function getFilteredCandidates() {
  let filtered = [...allCandidates];
  if (currentFilter.stage === '__followup__') {
    const now = new Date();
    const ACT = ['Outreach Sent', 'Replied', 'Resume Requested', 'Resume Received', 'Interviewing'];
    filtered = filtered.filter(c => {
      const stage = c.stage || 'Imported';
      if (stage === 'Closed' || stage === 'Imported') return false;
      if (c.followUpDate && new Date(c.followUpDate) <= now) return true;
      if (ACT.includes(stage) && !c.followUpDate) return true;
      return false;
    });
  } else if (currentFilter.stage) {
    filtered = filtered.filter(c => c.stage === currentFilter.stage);
  }
  if (currentFilter.search) {
    const q = currentFilter.search;
    filtered = filtered.filter(c =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q) ||
      (c.title || '').toLowerCase().includes(q) ||
      (c.company || '').toLowerCase().includes(q)
    );
  }
  if (currentTagFilter) {
    filtered = filtered.filter(c => (c.tags || []).includes(currentTagFilter));
  }
  // Date filter — by most recent activity (added, updated, or last message)
  const range = currentFilter.dateRange;
  if (range) {
    let cutoff = null;
    if (range === 'custom') {
      if (currentFilter.customDate) cutoff = new Date(currentFilter.customDate + 'T00:00:00');
    } else {
      const days = parseInt(range, 10);
      if (Number.isFinite(days)) cutoff = new Date(Date.now() - days * 86400000);
    }
    if (cutoff && !isNaN(cutoff)) {
      filtered = filtered.filter(c => candidateActivityDate(c) >= cutoff);
    }
  }
  return filtered;
}

// Most recent moment we touched this candidate: newest of created, updated,
// or last thread message. Used by the date filter.
function candidateActivityDate(c) {
  let t = 0;
  const consider = v => { if (v) { const d = new Date(v).getTime(); if (d > t) t = d; } };
  consider(c.createdAt);
  consider(c.updatedAt);
  if (Array.isArray(c.thread) && c.thread.length) {
    consider(c.thread[c.thread.length - 1].timestamp);
  }
  return new Date(t);
}

function renderTagFilterBar() {
  const bar = document.getElementById('tag-filter-bar');
  if (!bar) return;
  // Collect all unique tags across all candidates
  const allTags = [...new Set(allCandidates.flatMap(c => c.tags || []))].sort();
  if (allTags.length === 0) { bar.innerHTML = ''; return; }
  bar.innerHTML = `
    <span style="font-size:0.75rem;color:var(--text-muted);white-space:nowrap">Tags:</span>
    <button class="tag-filter-chip${!currentTagFilter ? ' active' : ''}" data-tag="">All</button>
    ${allTags.map(t => `<button class="tag-filter-chip${currentTagFilter === t ? ' active' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}
  `;
  bar.querySelectorAll('.tag-filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      currentTagFilter = chip.dataset.tag || null;
      renderTagFilterBar();
      renderCandidates();
    });
  });
}

function renderCandidates() {
  const filtered = getFilteredCandidates();
  document.getElementById('candidates-count').textContent = `${filtered.length} candidate${filtered.length !== 1 ? 's' : ''}`;

  // Metrics always use all candidates (no filter)
  renderMetricsBar(allCandidates);

  if (currentView === 'pipeline') {
    renderPipelineBoard(filtered, onCandidateSelect);
  } else {
    renderListView(filtered, onCandidateSelect);
  }
}

function updateUnreadBadge() {
  const count = allCandidates.filter(c => c.unread).length;
  const badge = document.getElementById('unread-badge');
  if (badge) {
    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
    badge.style.background = count > 0 ? '#ef4444' : '';
  }
}

function updateFollowUpBadge() {
  const now = new Date();
  const ACTIVE_STAGES = ['Outreach Sent', 'Replied', 'Resume Requested', 'Resume Received', 'Interviewing'];
  const count = allCandidates.filter(c => {
    const stage = c.stage || 'Imported';
    if (stage === 'Closed' || stage === 'Imported') return false;
    if (c.followUpDate && new Date(c.followUpDate) <= now) return true;
    if (ACTIVE_STAGES.includes(stage) && !c.followUpDate) return true;
    return false;
  }).length;
  const badge = document.getElementById('followup-badge');
  if (badge) {
    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
    badge.style.background = count > 0 ? '#f97316' : '';
  }
}

function updateHotLeadsBadge() {
  const count = allCandidates.filter(c =>
    c.opened && !(c.thread || []).some(m => m.direction === 'inbound')
  ).length;
  const badge = document.getElementById('hotleads-badge');
  if (badge) {
    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
    badge.style.background = count > 0 ? '#ef4444' : '';
  }
}

// ---- Hot Leads Page ----
// ---- Today (home) command center ----
async function loadTodayPage() {
  const el = document.getElementById('today-body');
  if (!el) return;

  // Greeting
  const hr = new Date().getHours();
  const part = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const first = (currentUser && currentUser.name ? currentUser.name.split(/\s+/)[0] : '') || '';
  const dateStr = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const greet = document.getElementById('today-greeting');
  if (greet) greet.innerHTML = `${part}${first ? ', ' + escapeHtml(first) : ''} <span style="font-size:0.8rem;font-weight:400;color:var(--text-muted);margin-left:8px">${dateStr}</span>`;

  // Buckets from the already-loaded candidate list
  const active = c => !['Closed'].includes(c.stage || '');
  const replies  = allCandidates.filter(c => c.unread);
  const interested = allCandidates.filter(c => c.replySentiment === 'interested' && active(c) && !c.unread);
  const now = new Date();
  const ACT = ['Outreach Sent', 'Replied', 'Resume Requested', 'Resume Received', 'Interviewing'];
  // Dedupe by priority: a candidate shows under replies > interested > follow-ups, once
  const claimed = new Set([...replies, ...interested].map(c => c.id));
  const followups = allCandidates.filter(c => {
    if (claimed.has(c.id)) return false;
    const stage = c.stage || 'Imported';
    if (stage === 'Closed' || stage === 'Imported') return false;
    if (c.followUpDate && new Date(c.followUpDate) <= now) return true;
    if (ACT.includes(stage) && !c.followUpDate) return true;
    return false;
  });
  const hotOpened = allCandidates.filter(c => c.opened && !(c.thread || []).some(m => m.direction === 'inbound'));

  // Async extras (best-effort)
  let analytics = null, ap = null;
  try { [analytics, ap] = await Promise.all([API.analytics.get().catch(() => null), API.settings.autopilotStatus().catch(() => null)]); } catch {}

  const row = (c, meta) => `
    <div class="today-row" data-id="${c.id}" style="display:flex;align-items:center;gap:12px;padding:11px 14px;border:1px solid var(--border);border-radius:9px;background:var(--bg-card);cursor:pointer;transition:border-color .12s">
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;color:var(--text);font-size:0.9rem">${escapeHtml(c.name || 'Unknown')}</div>
        <div style="font-size:0.78rem;color:var(--text-muted);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(c.title || '')}${c.company ? ' · ' + escapeHtml(c.company) : ''}</div>
      </div>
      <div style="font-size:0.76rem;color:var(--text-faint);flex-shrink:0;text-align:right">${meta || ''}</div>
    </div>`;

  const section = (icon, title, items, color, renderMeta, emptyHint) => {
    if (items.length === 0) return '';
    return `
      <div style="margin-bottom:22px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <span style="font-size:1.1rem">${icon}</span>
          <h3 style="margin:0;font-size:0.95rem;color:var(--text)">${title}</h3>
          <span style="background:${color}1f;color:${color};font-size:0.74rem;font-weight:700;border-radius:10px;padding:1px 9px">${items.length}</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${items.slice(0, 8).map(c => row(c, renderMeta ? renderMeta(c) : '')).join('')}
          ${items.length > 8 ? `<div style="font-size:0.78rem;color:var(--text-muted);padding:4px 2px">+ ${items.length - 8} more</div>` : ''}
        </div>
      </div>`;
  };

  const allClear = replies.length + interested.length + followups.length === 0;

  // Autopilot strip
  let apHtml = '';
  if (ap && ap.enabled) {
    const next = ap.nextAt ? new Date(ap.nextAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
    apHtml = `<div style="display:flex;align-items:center;gap:10px;padding:11px 14px;background:#eef2ff;border:1px solid #c7d2fe;border-radius:9px;font-size:0.82rem;color:#3730a3;margin-bottom:22px">
      <span style="font-size:1rem">🚀</span>
      <span><strong>Autopilot</strong> · sent ${ap.sentToday} today · ${ap.pendingToday} queued · next ${next} · ${ap.eligibleRemaining} left in pipeline</span>
    </div>`;
  }

  // Week stats strip
  let statsHtml = '';
  if (analytics) {
    const stat = (label, val, color) => `<div style="flex:1;text-align:center;padding:12px 8px"><div style="font-size:1.4rem;font-weight:700;color:${color||'var(--text)'}">${val}</div><div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px">${label}</div></div>`;
    statsHtml = `
      <div style="margin-top:10px">
        <h3 style="font-size:0.95rem;color:var(--text);margin:0 0 10px">📊 Your pipeline</h3>
        <div style="display:flex;border:1px solid var(--border);border-radius:10px;background:var(--bg-card);divide-x">
          ${stat('Total', analytics.total, '#6366f1')}
          ${stat('Contacted', analytics.contacted, '#2563eb')}
          ${stat('Open rate', analytics.openRate + '%', '#0891b2')}
          ${stat('Reply rate', analytics.responseRate + '%', '#16a34a')}
        </div>
      </div>`;
  }

  el.innerHTML = `
    ${apHtml}
    ${allClear ? `
      <div style="text-align:center;padding:40px 20px;border:1px dashed var(--border);border-radius:12px;margin-bottom:22px">
        <div style="font-size:2.2rem;margin-bottom:8px">✅</div>
        <h3 style="color:var(--text);margin:0 0 4px">You're all caught up</h3>
        <p style="color:var(--text-muted);font-size:0.88rem;margin:0">No replies, hot leads, or follow-ups need you right now. Nice.</p>
      </div>` : ''}
    ${section('💬', 'Replies need you', replies, '#7c3aed', c => {
      const last = [...(c.thread || [])].reverse().find(m => m.direction === 'inbound');
      return last ? formatRelativeHL(last.timestamp) : 'New';
    })}
    ${section('🔥', 'Interested — move these forward', interested, '#ef4444', c => 'Interested')}
    ${section('⏰', 'Follow-ups due', followups, '#d97706', c => c.followUpDate ? formatRelativeHL(c.followUpDate) : 'No reply yet')}
    ${hotOpened.length ? `<div style="margin-bottom:22px"><a id="today-hotleads-link" style="font-size:0.84rem;color:var(--blue);cursor:pointer">⚡ ${hotOpened.length} opened your email but haven't replied →</a></div>` : ''}
    ${statsHtml}
  `;

  // Row clicks → open candidate, refresh Today on close
  el.querySelectorAll('.today-row').forEach(r => {
    r.addEventListener('mouseenter', () => { r.style.borderColor = 'var(--blue)'; });
    r.addEventListener('mouseleave', () => { r.style.borderColor = 'var(--border)'; });
    r.addEventListener('click', () => {
      const c = allCandidates.find(x => x.id === r.dataset.id);
      if (!c) return;
      if (c.unread) {
        API.candidates.update(c.id, { unread: false }).then(u => { Object.assign(c, u); updateUnreadBadge(); }).catch(() => {});
      }
      openCandidateModal(c, currentUser,
        updated => { const i = allCandidates.findIndex(x => x.id === updated.id); if (i >= 0) allCandidates[i] = updated; loadTodayPage(); },
        id => { allCandidates = allCandidates.filter(x => x.id !== id); loadTodayPage(); }
      );
    });
  });
  const hl = el.querySelector('#today-hotleads-link');
  if (hl) hl.addEventListener('click', () => navigateTo('hotleads'));
}

function loadHotLeadsPage() {
  const el = document.getElementById('hotleads-content');
  if (!el) return;

  const hotLeads = allCandidates
    .filter(c => c.opened && !(c.thread || []).some(m => m.direction === 'inbound'))
    .sort((a, b) => new Date(a.openedAt || 0) - new Date(b.openedAt || 0)); // oldest open first = most urgent

  const subtitle = document.getElementById('hotleads-subtitle');
  if (subtitle) subtitle.textContent = `${hotLeads.length} candidate${hotLeads.length !== 1 ? 's' : ''} opened — no reply yet`;

  if (hotLeads.length === 0) {
    el.innerHTML = `<div style="text-align:center;padding:60px 20px">
      <div style="font-size:2.5rem;margin-bottom:12px">⚡</div>
      <h3 style="color:var(--text);margin-bottom:8px">No hot leads right now</h3>
      <p style="color:var(--text-muted);font-size:0.9rem">When a candidate opens your email but hasn't replied yet, they'll appear here.</p>
    </div>`;
    return;
  }

  el.innerHTML = `
    <div style="margin-bottom:16px;padding:12px 16px;background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;font-size:0.85rem;color:#92400e">
      🔥 These candidates opened your email but haven't replied yet. Strike while it's hot — send a follow-up now.
    </div>
    <div style="display:flex;flex-direction:column;gap:10px">
      ${hotLeads.map(c => {
        const daysSince = c.openedAt ? Math.floor((Date.now() - new Date(c.openedAt)) / 86400000) : null;
        const urgency = daysSince === null ? 'neutral' : daysSince <= 1 ? 'hot' : daysSince <= 3 ? 'warm' : 'cold';
        const urgencyColor = urgency === 'hot' ? '#ef4444' : urgency === 'warm' ? '#f97316' : '#94a3b8';
        const urgencyLabel = urgency === 'hot' ? '🔴 Today' : urgency === 'warm' ? '🟠 ' + daysSince + 'd ago' : '⚪ ' + daysSince + 'd ago';
        const lastSent = (c.thread || []).filter(m => m.direction === 'outbound').pop();
        return `
          <div style="display:flex;align-items:center;gap:14px;padding:14px 16px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;border-left:4px solid ${urgencyColor}">
            <div style="flex:1;min-width:0">
              <div style="font-weight:600;color:var(--text);font-size:0.95rem">${escapeHtml(c.name || 'Unknown')}</div>
              <div style="font-size:0.8rem;color:var(--text-muted);margin-top:2px">${escapeHtml(c.title || '')}${c.company ? ' · ' + escapeHtml(c.company) : ''}</div>
              ${lastSent ? `<div style="font-size:0.78rem;color:var(--text-faint);margin-top:4px">Last sent: ${formatRelativeHL(lastSent.timestamp)}</div>` : ''}
            </div>
            <div style="text-align:right;flex-shrink:0">
              <div style="font-size:0.82rem;font-weight:600;color:${urgencyColor};margin-bottom:6px">${urgencyLabel}</div>
              <button class="btn btn-primary btn-sm hl-followup-btn" data-id="${c.id}" style="white-space:nowrap">Send Follow-Up</button>
            </div>
          </div>`;
      }).join('')}
    </div>
  `;

  // Wire follow-up buttons
  el.querySelectorAll('.hl-followup-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const candidate = allCandidates.find(c => c.id === btn.dataset.id);
      if (!candidate) return;
      btn.disabled = true; btn.textContent = 'Generating…';
      try {
        const { body } = await API.ai.followup(candidate.id);
        // Open candidate modal on thread tab with pre-filled follow-up
        openCandidateModal(candidate, currentUser,
          updated => { Object.assign(candidate, updated); loadHotLeadsPage(); },
          () => {}
        );
        setTimeout(() => switchModalTab('thread'), 100);
        Toast.show('Follow-up draft generated — review in the Thread tab');
      } catch (err) {
        Toast.error('Failed to generate follow-up: ' + err.message);
        btn.disabled = false; btn.textContent = 'Send Follow-Up';
      }
    });
  });

  // Refresh button
  const refreshBtn = document.getElementById('hotleads-refresh-btn');
  if (refreshBtn) {
    const fresh = refreshBtn.cloneNode(true);
    refreshBtn.parentNode.replaceChild(fresh, refreshBtn);
    fresh.addEventListener('click', async () => {
      allCandidates = await API.candidates.list();
      loadHotLeadsPage();
    });
  }
}

function formatRelativeHL(iso) {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  const days = Math.floor((now - d) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

// ---- Candidate selection ----
function onCandidateSelect(candidate) {
  // Mark as read
  if (candidate.unread) {
    API.candidates.update(candidate.id, { unread: false }).then(updated => {
      Object.assign(candidate, updated);
      const idx = allCandidates.findIndex(c => c.id === candidate.id);
      if (idx >= 0) allCandidates[idx] = candidate;
      updateUnreadBadge();
      renderCandidates();
    }).catch(() => {});
  }

  openCandidateModal(
    candidate,
    currentUser,
    (updated) => {
      const idx = allCandidates.findIndex(c => c.id === updated.id);
      if (idx >= 0) allCandidates[idx] = updated;
      renderCandidates();
      updateUnreadBadge();
    },
    (id) => {
      allCandidates = allCandidates.filter(c => c.id !== id);
      renderCandidates();
      updateUnreadBadge();
    }
  );
}

// ---- Import CSV ----
async function handleImport() {
  const fileInput = document.getElementById('import-csv-file');
  const file = fileInput.files[0];
  if (!file) { Toast.warning('Please select a CSV file'); return; }

  const btn = document.getElementById('import-submit-btn');
  btn.disabled = true; btn.textContent = 'Importing…';
  try {
    const fd = new FormData();
    fd.append('csv', file);
    const result = await API.candidates.import(fd);
    const skippedMsg = [];
    if (result.skipped > 0) skippedMsg.push(`${result.skipped} skipped (no email)`);
    if (result.duplicates > 0) skippedMsg.push(`${result.duplicates} duplicates`);
    Toast.success(`Imported ${result.imported} candidates${skippedMsg.length ? ` (${skippedMsg.join(', ')})` : ''}`);
    new Modal('import-modal').close();
    fileInput.value = '';
    await loadCandidates();
  } catch (err) {
    Toast.error('Import failed: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Import Candidates';
  }
}

// ---- Add candidate ----
async function handleAddCandidate() {
  const data = {
    name: document.getElementById('new-name').value.trim(),
    email: document.getElementById('new-email').value.trim(),
    title: document.getElementById('new-title').value.trim(),
    company: document.getElementById('new-company').value.trim(),
    linkedin: document.getElementById('new-linkedin').value.trim(),
    summary: document.getElementById('new-summary').value.trim()
  };
  if (!data.name || !data.email) { Toast.warning('Name and email are required'); return; }

  const btn = document.getElementById('add-candidate-submit-btn');
  btn.disabled = true; btn.textContent = 'Adding…';
  try {
    const candidate = await API.candidates.create(data);
    allCandidates.unshift(candidate);
    renderCandidates();
    new Modal('add-candidate-modal').close();
    document.getElementById('add-candidate-form').reset();
    Toast.success('Candidate added');
    onCandidateSelect(candidate);
  } catch (err) {
    Toast.error('Failed to add candidate: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Add Candidate';
  }
}

// ---- Fetch emails ----
async function handleFetchEmails() {
  const btn = document.getElementById('fetch-email-btn');
  btn.disabled = true; btn.textContent = 'Checking…';
  try {
    const result = await API.email.fetch();
    if (result.matched > 0) {
      Toast.success(`${result.matched} new repl${result.matched === 1 ? 'y' : 'ies'} received`);
      await loadCandidates();
    } else if (result.fetched > 0) {
      // Emails were fetched from Gmail but none matched a candidate —
      // log what was found so we can diagnose the mismatch
      console.warn('[Fetch] Fetched', result.fetched, 'emails but 0 matched candidates.');
      if (result.debug && result.debug.length) {
        console.table(result.debug.map(d => ({ from: d.from, subject: d.subject })));
      }
      Toast.show(`Checked ${result.fetched} email${result.fetched === 1 ? '' : 's'} — no candidate match found. Check console for details.`);
    } else {
      Toast.show('No new emails found in the last 14 days');
    }
  } catch (err) {
    if (!handleReauthError(err)) Toast.error('Failed to fetch emails: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = '↓ Replies';
  }
}

// ---- Bulk stage ----
async function handleBulkStage() {
  const checkboxes = document.querySelectorAll('.row-cb:checked');
  if (checkboxes.length === 0) { Toast.warning('No candidates selected'); return; }
  const ids = Array.from(checkboxes).map(cb => cb.dataset.id);
  const stage = document.getElementById('bulk-stage-select').value;
  if (!stage) { Toast.warning('Select a stage first'); return; }
  try {
    await API.candidates.bulkStage(ids, stage);
    Toast.success(`Updated ${ids.length} candidate${ids.length !== 1 ? 's' : ''} to "${stage}"`);
    await loadCandidates();
  } catch (err) {
    Toast.error(err.message);
  }
}

// ---- Export CSV ----
function exportCSV() {
  const filtered = getFilteredCandidates();
  if (filtered.length === 0) { Toast.warning('No candidates to export'); return; }

  const headers = ['Name','Email','Title','Company','LinkedIn','Stage','Tags','Notes','Last Updated'];
  const rows = filtered.map(c => [
    c.name || '',
    c.email || '',
    c.title || '',
    c.company || '',
    c.linkedin || '',
    c.stage || 'Imported',
    (c.tags || []).join('; '),
    (c.notes || '').replace(/\n/g,' '),
    c.updatedAt ? new Date(c.updatedAt).toLocaleDateString() : ''
  ]);

  const csv = [headers, ...rows].map(row =>
    row.map(cell => `"${String(cell).replace(/"/g,'""')}"`).join(',')
  ).join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `welltower-pipeline-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  Toast.success(`Exported ${filtered.length} candidates`);
}

// ---- Bulk Outreach ----
function randDelayMs() {
  // Random 3–8 minute delay
  return (Math.floor(Math.random() * 6) + 3) * 60 * 1000;
}
function fmtMins(ms) {
  const m = Math.floor(ms / 60000);
  return m === 1 ? '1 min' : `${m} mins`;
}

function applyBulkLimit(n) {
  // n = number or null/0 = all
  const cbs = [...document.querySelectorAll('.bulk-cb')];
  cbs.forEach((cb, i) => {
    cb.checked = (!n || n <= 0) ? true : i < n;
  });
  const limitInput = document.getElementById('bulk-limit-input');
  if (limitInput) limitInput.value = (n && n > 0) ? n : '';
  window._bulkDelays = null;
  buildSchedulePreview();
}

function openBulkOutreachModal() {
  // Exclude anyone already contacted: stage advanced past Imported, outreach step done,
  // OR any outbound thread message (covers sends via thread tab or external tracking)
  const imported = allCandidates.filter(c => {
    if ((c.stage || 'Imported') !== 'Imported') return false;
    if ((c.stepsCompleted || {}).outreach) return false;
    if ((c.thread || []).some(m => m.direction === 'outbound')) return false;
    return true;
  });
  const list = document.getElementById('bulk-outreach-list');
  const checkBanner = document.getElementById('bulk-gmail-check');

  if (imported.length === 0) {
    Toast.warning('No Imported candidates without outreach already sent');
    return;
  }

  list.innerHTML = imported.map(c => `
    <label style="display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:6px;cursor:pointer;font-size:0.85rem;color:var(--text)" data-email="${escapeHtml(c.email||'')}">
      <input type="checkbox" class="bulk-cb" data-id="${c.id}" data-name="${escapeHtml(c.name||'')}" data-email="${escapeHtml(c.email||'')}" checked />
      <span style="font-weight:500">${escapeHtml(c.name||'Unknown')}</span>
      <span style="color:var(--text-muted);font-size:0.78rem">${escapeHtml(c.title||'')}${c.company?' · '+escapeHtml(c.company):''}</span>
      <span class="prior-contact-badge" style="display:none;margin-left:auto;font-size:0.72rem;color:#b45309;background:#fef3c7;border:1px solid #fcd34d;padding:1px 7px;border-radius:10px;white-space:nowrap">⚠ Already emailed</span>
    </label>
  `).join('');

  // ── Gmail sent-history check ─────────────────────────────────────────────
  checkBanner.style.display = 'none';
  const emails = imported.map(c => c.email).filter(Boolean);
  if (emails.length > 0) {
    checkBanner.style.display = 'block';
    checkBanner.style.cssText = 'display:block;font-size:0.8rem;padding:7px 10px;border-radius:6px;margin-bottom:8px;background:#f0f9ff;border:1px solid #bae6fd;color:#0369a1';
    checkBanner.textContent = '🔍 Checking Gmail sent history for prior contacts…';

    API.email.checkPriorContact(emails).then(result => {
      const contacted = new Set((result.contacted || []).map(e => e.toLowerCase()));
      if (contacted.size === 0) {
        checkBanner.style.cssText = 'display:block;font-size:0.8rem;padding:7px 10px;border-radius:6px;margin-bottom:8px;background:#f0fdf4;border:1px solid #bbf7d0;color:#15803d';
        checkBanner.textContent = '✓ No prior contacts found in Gmail — all clear';
        return;
      }

      let skipped = 0;
      list.querySelectorAll('.bulk-cb').forEach(cb => {
        const email = (cb.dataset.email || '').toLowerCase();
        if (contacted.has(email)) {
          cb.checked = false;
          cb.closest('label').style.opacity = '0.5';
          cb.closest('label').querySelector('.prior-contact-badge').style.display = 'inline';
          skipped++;
        }
      });

      checkBanner.style.cssText = 'display:block;font-size:0.8rem;padding:7px 10px;border-radius:6px;margin-bottom:8px;background:#fffbeb;border:1px solid #fcd34d;color:#92400e';
      checkBanner.innerHTML = `⚠ <strong>${skipped} candidate${skipped !== 1 ? 's' : ''}</strong> unchecked — prior email found in Gmail sent history. Re-check to include them anyway.`;

      // Sync limit input and preview after unchecking
      const checkedCount = document.querySelectorAll('.bulk-cb:checked').length;
      const limitInput = document.getElementById('bulk-limit-input');
      if (limitInput) limitInput.value = checkedCount < imported.length ? checkedCount : '';
      window._bulkDelays = null;
      buildSchedulePreview();
    }).catch(() => {
      checkBanner.style.cssText = 'display:block;font-size:0.8rem;padding:7px 10px;border-radius:6px;margin-bottom:8px;background:#f8fafc;border:1px solid #e2e8f0;color:#64748b';
      checkBanner.textContent = 'Gmail check unavailable — verify manually before sending';
    });
  }

  list.querySelectorAll('.bulk-cb').forEach(cb => cb.addEventListener('change', () => {
    // Sync the limit input to match checked count
    const checkedCount = document.querySelectorAll('.bulk-cb:checked').length;
    const limitInput = document.getElementById('bulk-limit-input');
    if (limitInput) limitInput.value = checkedCount < imported.length ? checkedCount : '';
    window._bulkDelays = null;
    buildSchedulePreview();
  }));

  // "of N candidates" label
  const ofEl = document.getElementById('bulk-limit-of');
  if (ofEl) ofEl.textContent = `of ${imported.length} candidate${imported.length !== 1 ? 's' : ''}`;

  // Limit input — typing a number checks/unchecks accordingly
  const limitInput = document.getElementById('bulk-limit-input');
  if (limitInput) {
    limitInput.value = '';
    // Remove old listener by cloning
    const fresh = limitInput.cloneNode(true);
    limitInput.parentNode.replaceChild(fresh, limitInput);
    fresh.addEventListener('input', () => {
      const v = parseInt(fresh.value, 10);
      applyBulkLimit(isNaN(v) ? 0 : Math.min(v, imported.length));
    });
  }

  // Quick-select chips
  document.querySelectorAll('.bulk-quick-btn').forEach(btn => {
    const clone = btn.cloneNode(true);
    btn.parentNode.replaceChild(clone, btn);
    clone.addEventListener('click', () => {
      const n = clone.dataset.n === 'all' ? 0 : parseInt(clone.dataset.n, 10);
      applyBulkLimit(n);
    });
  });

  document.getElementById('bulk-progress').textContent = '';
  document.getElementById('bulk-schedule-preview').style.display = 'none';
  document.getElementById('bulk-outreach-start-btn').disabled = false;
  document.getElementById('bulk-outreach-start-btn').textContent = 'Queue Emails';
  window._bulkDelays = null;
  buildSchedulePreview();

  // Wire time-window checkbox
  const windowCb = document.getElementById('bulk-use-window');
  const windowInputs = document.getElementById('bulk-window-inputs');
  if (windowCb && windowInputs) {
    // Reset state
    windowCb.checked = false;
    windowInputs.style.opacity = '0.4';
    windowInputs.style.pointerEvents = 'none';
    // Clone to remove any old listeners
    const freshCb = windowCb.cloneNode(true);
    windowCb.parentNode.replaceChild(freshCb, windowCb);
    freshCb.addEventListener('change', () => {
      windowInputs.style.opacity = freshCb.checked ? '1' : '0.4';
      windowInputs.style.pointerEvents = freshCb.checked ? 'auto' : 'none';
      window._bulkDelays = null;
      buildSchedulePreview();
    });
    // Re-build preview when start/end times change
    windowInputs.querySelectorAll('input[type=time]').forEach(inp => {
      const fresh = inp.cloneNode(true);
      inp.parentNode.replaceChild(fresh, inp);
      fresh.addEventListener('change', () => { window._bulkDelays = null; buildSchedulePreview(); });
    });
  }

  // Smart send-time toggle — when on, hide the manual window (server decides timing)
  const smartCb = document.getElementById('bulk-smart-time');
  const manualWindow = document.getElementById('bulk-manual-window');
  if (smartCb) {
    smartCb.checked = false;
    const freshSmart = smartCb.cloneNode(true);
    smartCb.parentNode.replaceChild(freshSmart, smartCb);
    freshSmart.addEventListener('change', () => {
      if (manualWindow) manualWindow.style.display = freshSmart.checked ? 'none' : '';
      const preview = document.getElementById('bulk-schedule-preview');
      if (preview) preview.style.display = freshSmart.checked ? 'none' : (window._scheduledTimes ? 'block' : 'none');
    });
  }

  new Modal('bulk-outreach-modal').open();

  // If there's already an active server queue, show its status
  refreshQueueStatus();
}

// Returns the next send time after `afterMs` that falls inside [startH:startM – endH:endM] on weekdays
function nextWindowSlot(afterMs, startH, startM, endH, endM, weekdaysOnly) {
  const candidate = new Date(afterMs);
  // Advance up to 14 days trying to find a valid slot
  for (let d = 0; d < 14; d++) {
    const dow = candidate.getDay();
    if (!weekdaysOnly || (dow >= 1 && dow <= 5)) {
      const slotStart = new Date(candidate);
      slotStart.setHours(startH, startM, 0, 0);
      const slotEnd = new Date(candidate);
      slotEnd.setHours(endH, endM, 0, 0);
      if (candidate >= slotStart && candidate < slotEnd) return candidate.getTime(); // already inside window
      if (candidate < slotStart) { return slotStart.getTime(); } // push to window start today
    }
    // Move to tomorrow's window start
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(startH, startM, 0, 0);
  }
  return afterMs; // fallback — return unchanged
}

function buildSchedulePreview() {
  const checked = [...document.querySelectorAll('.bulk-cb:checked')];
  const preview  = document.getElementById('bulk-schedule-preview');
  const listEl   = document.getElementById('bulk-schedule-list');
  const totalEl  = document.getElementById('bulk-schedule-total');

  if (checked.length === 0) { preview.style.display = 'none'; return; }

  // Generate (or reuse) delays
  if (!window._bulkDelays || window._bulkDelays.length !== checked.length) {
    window._bulkDelays = checked.map((_, i) => i === 0 ? 0 : randDelayMs());
  }

  // Time-window settings
  const useWindow   = document.getElementById('bulk-use-window')?.checked;
  const weekdaysOnly = useWindow; // weekdays-only implied when window is on
  const startVal = document.getElementById('bulk-window-start')?.value || '09:00';
  const endVal   = document.getElementById('bulk-window-end')?.value   || '11:00';
  const [sH, sM] = startVal.split(':').map(Number);
  const [eH, eM] = endVal.split(':').map(Number);

  const baseMs = Date.now();
  let cumMs = 0;
  const scheduledTimes = checked.map((cb, i) => {
    cumMs += window._bulkDelays[i];
    let t = baseMs + cumMs;
    if (useWindow) t = nextWindowSlot(t, sH, sM, eH, eM, weekdaysOnly);
    return t;
  });

  listEl.innerHTML = checked.map((cb, i) => {
    const t = new Date(scheduledTimes[i]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = (() => {
      const d = new Date(scheduledTimes[i]);
      const today = new Date();
      if (d.toDateString() === today.toDateString()) return '';
      return ' ' + d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    })();
    const gap = i === 0 ? '<span style="color:#10b981;font-weight:600">Now</span>' : `<span style="color:#94a3b8">+${fmtMins(window._bulkDelays[i])}</span>`;
    return `<div style="display:flex;align-items:center;gap:10px;padding:3px 0">
      <span style="min-width:100px;color:#475569;font-size:0.82rem">${t}${dateStr}</span>
      <span style="min-width:56px;font-size:0.78rem">${gap}</span>
      <span style="font-weight:500">${escapeHtml(cb.dataset.name)}</span>
    </div>`;
  }).join('');

  const spanMs = scheduledTimes[scheduledTimes.length - 1] - baseMs;
  const spanMins = Math.round(spanMs / 60000);
  const spanDesc = spanMins < 60 ? `~${spanMins} min` : `~${Math.round(spanMins / 60)} hr`;
  totalEl.textContent = `${checked.length} email${checked.length !== 1 ? 's' : ''} spread over ${spanDesc} — runs on the server, safe to close this window`;
  preview.style.display = 'block';
  // Store computed schedule times for use in handleBulkOutreach
  window._scheduledTimes = scheduledTimes;
}

async function handleBulkOutreach() {
  const checked = [...document.querySelectorAll('.bulk-cb:checked')];
  if (checked.length === 0) { Toast.warning('Select at least one candidate'); return; }

  const startBtn   = document.getElementById('bulk-outreach-start-btn');
  const progressEl = document.getElementById('bulk-progress');

  // Smart send-time path: let the server compute each recipient's optimal window
  // (Tue–Thu 9am in their timezone). Subject is AI-generated per candidate.
  if (document.getElementById('bulk-smart-time')?.checked) {
    startBtn.disabled = true; startBtn.textContent = 'Queuing…';
    try {
      const ids = checked.map(cb => cb.dataset.id);
      const result = await API.queue.bulkOutreach(ids, 'optimal');
      Toast.success(`${result.queued} email${result.queued !== 1 ? 's' : ''} queued at smart send-times${result.skipped ? ` (${result.skipped} skipped)` : ''}`);
      startBtn.textContent = 'Queued ✓';
      progressEl.textContent = `${result.queued} emails scheduled for each recipient's timezone`;
      startQueuePolling();
    } catch (err) {
      Toast.error(err.message);
      startBtn.disabled = false; startBtn.textContent = 'Generate & Queue';
    }
    return;
  }

  const subjectTpl = document.getElementById('bulk-subject').value.trim();

  // Use pre-computed schedule times (respects time windows) or fall back to live calc
  const delays = window._bulkDelays || checked.map((_, i) => i === 0 ? 0 : randDelayMs());
  let scheduledTimes = window._scheduledTimes;
  if (!scheduledTimes || scheduledTimes.length !== checked.length) {
    const now = Date.now();
    let cum = 0;
    scheduledTimes = delays.map(d => { cum += d; return now + cum; });
  }

  const jobs = checked.map((cb, i) => {
    const firstName = (cb.dataset.name || '').split(' ')[0];
    const subject   = subjectTpl || `Something Worth a Few Minutes of Your Time, ${firstName}`;
    return {
      candidateId:   cb.dataset.id,
      candidateName: cb.dataset.name,
      subject,
      scheduledAt:   new Date(scheduledTimes[i]).toISOString()
    };
  });

  startBtn.disabled = true;
  startBtn.textContent = 'Queuing…';

  try {
    const result = await API.queue.create(jobs);
    Toast.success(`${result.queued} email${result.queued !== 1 ? 's' : ''} queued — they'll send even if you close this window`);
    window._bulkDelays = null;
    startBtn.textContent = 'Queued ✓';
    progressEl.textContent = `${result.queued} emails scheduled on the server`;

    // Start polling so the modal shows live progress
    startQueuePolling();
  } catch (err) {
    Toast.error(err.message);
    startBtn.disabled = false;
    startBtn.textContent = 'Queue Emails';
  }
}

// ---- Queue status polling ----
let _queuePollTimer = null;

function startQueuePolling() {
  if (_queuePollTimer) clearInterval(_queuePollTimer);
  refreshQueueStatus();
  _queuePollTimer = setInterval(refreshQueueStatus, 15000);
}

async function refreshQueueStatus() {
  try {
    const { jobs } = await API.queue.status();
    renderQueueStatus(jobs);
    // Stop polling when nothing is pending/sending
    const active = jobs.filter(j => j.status === 'pending' || j.status === 'sending');
    if (active.length === 0 && _queuePollTimer) {
      clearInterval(_queuePollTimer);
      _queuePollTimer = null;
      await loadCandidates(); // refresh candidate list now that emails have sent
    }
  } catch { /* ignore */ }
}

function renderQueueStatus(jobs) {
  if (!jobs || jobs.length === 0) return;
  const listEl = document.getElementById('bulk-schedule-list');
  const totalEl = document.getElementById('bulk-schedule-total');
  const preview = document.getElementById('bulk-schedule-preview');

  const statusIcon = { pending: '⏳', sending: '📤', sent: '✅', failed: '❌', cancelled: '🚫' };
  const statusColor = { pending: '#64748b', sending: '#3b82f6', sent: '#10b981', failed: '#ef4444', cancelled: '#94a3b8' };

  listEl.innerHTML = jobs.map(j => {
    const t = new Date(j.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const icon  = statusIcon[j.status] || '·';
    const color = statusColor[j.status] || '#64748b';
    const extra = j.status === 'failed' ? ` <span style="color:#ef4444;font-size:0.75rem">${escapeHtml(j.error||'')}</span>` : '';
    return `<div style="display:flex;align-items:center;gap:10px;padding:3px 0">
      <span style="min-width:72px;color:#475569;font-size:0.82rem">${t}</span>
      <span style="font-size:0.9rem">${icon}</span>
      <span style="font-weight:500;color:${color}">${escapeHtml(j.candidateName)}</span>${extra}
    </div>`;
  }).join('');

  const pending = jobs.filter(j => j.status === 'pending').length;
  const sent    = jobs.filter(j => j.status === 'sent').length;
  totalEl.textContent = `${sent} sent · ${pending} pending`;
  preview.style.display = 'block';

  // Wire cancel button if there are pending jobs
  const cancelBtn = document.getElementById('bulk-outreach-cancel-btn');
  if (pending > 0) {
    cancelBtn.textContent = 'Cancel Queue';
    cancelBtn.onclick = async () => {
      await API.queue.cancel();
      Toast.info('Queue cancelled');
      clearInterval(_queuePollTimer); _queuePollTimer = null;
      refreshQueueStatus();
      cancelBtn.textContent = 'Close';
      cancelBtn.onclick = () => new Modal('bulk-outreach-modal').close();
    };
  }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- Follow-Up Hub ----
function loadFollowUpPage() {
  const now = new Date();
  // Active stages that mean "this candidate is in the pipeline and needs attention"
  const ACTIVE_STAGES = ['Outreach Sent', 'Replied', 'Resume Requested', 'Resume Received', 'Interviewing'];

  const due = allCandidates
    .filter(c => {
      const stage = c.stage || 'Imported';
      if (stage === 'Closed' || stage === 'Imported') return false;
      // Explicit reminder that's now due
      if (c.followUpDate && new Date(c.followUpDate) <= now) return true;
      // In an active stage with no reminder set at all → needs attention
      if (ACTIVE_STAGES.includes(stage) && !c.followUpDate) return true;
      return false;
    })
    .sort((a, b) => {
      // Overdue with date first (sorted by date), then no-date entries
      const aDate = a.followUpDate ? new Date(a.followUpDate) : new Date(0);
      const bDate = b.followUpDate ? new Date(b.followUpDate) : new Date(0);
      return aDate - bDate;
    });

  const listEl   = document.getElementById('followup-list');
  const emptyEl  = document.getElementById('followup-empty');
  const countEl  = document.getElementById('followups-count');
  if (!listEl) return;

  // Refresh button
  const refreshBtn = document.getElementById('followup-refresh-btn');
  if (refreshBtn) { refreshBtn.onclick = () => loadFollowUpPage(); }

  if (due.length === 0) {
    listEl.innerHTML = '';
    emptyEl.style.display = 'block';
    countEl.textContent = '';
    updateFollowUpBadge();
    return;
  }

  emptyEl.style.display = 'none';
  countEl.textContent = `${due.length} due`;

  listEl.innerHTML = due.map(c => {
    const daysOver = c.followUpDate ? Math.floor((now - new Date(c.followUpDate)) / 86400000) : null;
    const overdueLabel = daysOver === null ? 'No reminder set' : daysOver === 0 ? 'Due today' : `${daysOver}d overdue`;
    const overdueColor = daysOver === null ? '#64748b' : daysOver === 0 ? '#d97706' : '#ef4444';
    const lastMsg = [...(c.thread || [])].reverse()[0];
    const preview  = lastMsg ? preview55(lastMsg.body) : (c.summary ? preview55(c.summary) : '');
    const lastDir  = lastMsg ? (lastMsg.direction === 'inbound' ? '← They said:' : '→ You said:') : '';

    // Context label
    const steps = c.stepsCompleted || {};
    let contextLabel = 'General follow-up';
    if (steps.resumeRequested && !steps.resumeReceived) contextLabel = 'Waiting for resume';
    else if (steps.roleJD && !(c.thread||[]).some(m => m.direction==='inbound')) contextLabel = 'No reply after JD sent';
    else if (steps.outreach && !(c.thread||[]).some(m => m.direction==='inbound')) contextLabel = 'No reply to outreach';

    return `
    <div class="settings-card" id="fu-card-${c.id}" style="margin:0">
      <div class="settings-card-body" style="padding:16px 20px">
        <div style="display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap">
          <!-- Left: info -->
          <div style="flex:1;min-width:200px">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
              <span style="font-weight:600;font-size:0.95rem;color:var(--text)">${escapeHtml(c.name||'Unknown')}</span>
              <span style="font-size:0.75rem;font-weight:600;color:${overdueColor};background:${overdueColor}18;border:1px solid ${overdueColor}40;padding:1px 8px;border-radius:10px">${overdueLabel}</span>
              <span style="font-size:0.72rem;color:#94a3b8;background:#f1f5f9;padding:1px 7px;border-radius:10px">${escapeHtml(contextLabel)}</span>
            </div>
            <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:6px">${escapeHtml(c.title||'')}${c.company?` · ${escapeHtml(c.company)}`:''} · <span style="color:#64748b">${escapeHtml(c.stage||'Imported')}</span></div>
            ${preview ? `<div style="font-size:0.8rem;color:#94a3b8;font-style:italic"><span style="color:#64748b">${lastDir}</span> ${escapeHtml(preview)}</div>` : ''}
          </div>
          <!-- Right: actions -->
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;flex-shrink:0">
            <button class="btn btn-primary btn-sm fu-draft-btn" data-id="${c.id}" style="white-space:nowrap">✦ AI Draft</button>
            <button class="btn btn-secondary btn-sm fu-snooze-btn" data-id="${c.id}" data-days="3" style="white-space:nowrap">Snooze 3d</button>
            <button class="btn btn-secondary btn-sm fu-snooze-btn" data-id="${c.id}" data-days="7" style="white-space:nowrap">Snooze 7d</button>
            <button class="btn btn-ghost btn-sm fu-done-btn" data-id="${c.id}" style="white-space:nowrap;color:#94a3b8">✓ Done</button>
          </div>
        </div>
        <!-- Inline draft panel (hidden by default) -->
        <div class="fu-draft-panel" id="fu-draft-${c.id}" style="display:none;margin-top:14px;border-top:1px solid var(--border);padding-top:14px">
          <div style="margin-bottom:8px;display:flex;align-items:center;gap:8px">
            <label style="font-size:0.78rem;color:#64748b;white-space:nowrap">Subject:</label>
            <input type="text" id="fu-subject-${c.id}" style="flex:1;font-size:0.85rem"
              value="Re: ${escapeHtml(c.originalSubject || `Something Worth a Few Minutes of Your Time, ${(c.name||'').split(' ')[0]}`)}" />
          </div>
          <textarea id="fu-body-${c.id}" style="width:100%;min-height:200px;font-size:0.85rem;line-height:1.6;resize:vertical;font-family:inherit" placeholder="Generating…"></textarea>
          <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
            <button class="btn btn-primary btn-sm fu-send-btn" data-id="${c.id}">Send Follow-Up</button>
            <button class="btn btn-ghost btn-sm fu-discard-btn" data-id="${c.id}">Discard</button>
            <button class="btn btn-ghost btn-sm fu-regen-btn" data-id="${c.id}" style="margin-left:auto;color:#94a3b8">↺ Regenerate</button>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');

  // ── Wire up all row actions ─────────────────────────────────────────────
  listEl.querySelectorAll('.fu-draft-btn').forEach(btn => {
    btn.addEventListener('click', () => openFollowUpDraft(btn.dataset.id));
  });

  listEl.querySelectorAll('.fu-regen-btn').forEach(btn => {
    btn.addEventListener('click', () => openFollowUpDraft(btn.dataset.id, true));
  });

  listEl.querySelectorAll('.fu-snooze-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const days = parseInt(btn.dataset.days, 10);
      const snoozeDate = new Date(Date.now() + days * 86400000).toISOString();
      btn.disabled = true; btn.textContent = 'Snoozing…';
      try {
        await API.candidates.update(btn.dataset.id, { followUpDate: snoozeDate });
        const c = allCandidates.find(x => x.id === btn.dataset.id);
        if (c) c.followUpDate = snoozeDate;
        Toast.success(`Follow-up snoozed ${days} days`);
        loadFollowUpPage();
      } catch (err) { Toast.error(err.message); btn.disabled = false; btn.textContent = `Snooze ${days}d`; }
    });
  });

  listEl.querySelectorAll('.fu-done-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Marking…';
      try {
        await API.candidates.update(btn.dataset.id, { followUpDate: null });
        const c = allCandidates.find(x => x.id === btn.dataset.id);
        if (c) c.followUpDate = null;
        Toast.success('Follow-up marked done');
        loadFollowUpPage();
      } catch (err) { Toast.error(err.message); btn.disabled = false; btn.textContent = '✓ Done'; }
    });
  });

  listEl.querySelectorAll('.fu-discard-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const panel = document.getElementById(`fu-draft-${btn.dataset.id}`);
      if (panel) panel.style.display = 'none';
    });
  });

  listEl.querySelectorAll('.fu-send-btn').forEach(btn => {
    btn.addEventListener('click', () => sendFollowUpEmail(btn.dataset.id));
  });

  updateFollowUpBadge();
}

async function openFollowUpDraft(candidateId, regen = false) {
  const panel   = document.getElementById(`fu-draft-${candidateId}`);
  const bodyEl  = document.getElementById(`fu-body-${candidateId}`);
  const draftBtn = document.querySelector(`.fu-draft-btn[data-id="${candidateId}"]`);
  if (!panel || !bodyEl) return;

  panel.style.display = 'block';
  bodyEl.value = 'Generating…';
  bodyEl.disabled = true;
  if (draftBtn) { draftBtn.disabled = true; draftBtn.textContent = 'Generating…'; }

  try {
    const result = await API.ai.followup(candidateId);
    bodyEl.value = result.draft || '';
    bodyEl.disabled = false;
  } catch (err) {
    bodyEl.value = '';
    bodyEl.disabled = false;
    Toast.error('Failed to generate follow-up: ' + err.message);
  } finally {
    if (draftBtn) { draftBtn.disabled = false; draftBtn.textContent = '✦ AI Draft'; }
  }
}

async function sendFollowUpEmail(candidateId) {
  const bodyEl    = document.getElementById(`fu-body-${candidateId}`);
  const subjectEl = document.getElementById(`fu-subject-${candidateId}`);
  const sendBtn   = document.querySelector(`.fu-send-btn[data-id="${candidateId}"]`);
  if (!bodyEl || !subjectEl) return;

  const body    = bodyEl.value.trim();
  const subject = subjectEl.value.trim();
  if (!body) { Toast.warning('Draft is empty'); return; }

  const candidate = allCandidates.find(c => c.id === candidateId);
  if (!candidate) return;

  sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
  try {
    await API.email.send({
      candidateId,
      subject,
      body,
      isReply: !!(candidate.gmailThreadId)
    });
    // Clear the follow-up date and refresh
    await API.candidates.update(candidateId, { followUpDate: null });
    if (candidate) candidate.followUpDate = null;
    Toast.success(`Follow-up sent to ${candidate.name}`);
    allCandidates = await API.candidates.list();
    loadFollowUpPage();
  } catch (err) {
    if (!handleReauthError(err)) Toast.error('Failed to send: ' + err.message);
    sendBtn.disabled = false; sendBtn.textContent = 'Send Follow-Up';
  }
}

// ---- Analytics Page ----
async function loadAnalyticsPage() {
  const el = document.getElementById('analytics-content');
  if (!el) return;
  el.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-muted)">Loading…</div>`;
  try {
    const d = await API.analytics.get();
    const STAGE_COLORS_LOCAL = {
      'Imported':'#64748b','Outreach Sent':'#2563eb','Replied':'#7c3aed',
      'Resume Requested':'#d97706','Resume Received':'#0891b2','Interviewing':'#16a34a','Closed':'#374151'
    };
    const stageRows = Object.entries(d.stageCounts).map(([s,n]) => {
      const color = STAGE_COLORS_LOCAL[s] || '#64748b';
      const pct = d.total > 0 ? Math.round((n/d.total)*100) : 0;
      return `<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--border)">
        <span style="width:160px;font-size:0.85rem;color:var(--text)">${s}</span>
        <div style="flex:1;background:var(--border);border-radius:4px;height:8px">
          <div style="width:${pct}%;background:${color};height:8px;border-radius:4px;transition:width .4s"></div>
        </div>
        <span style="width:32px;text-align:right;font-weight:600;color:${color}">${n}</span>
      </div>`;
    }).join('');

    const followUpHtml = d.followUpCandidates && d.followUpCandidates.length
      ? d.followUpCandidates.map(c => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
          <span style="font-size:0.875rem;font-weight:500">${escapeHtml(c.name)}</span>
          <span style="font-size:0.78rem;color:var(--text-muted)">${c.stage}</span>
          <span style="font-size:0.78rem;color:#ef4444;font-weight:600">Due ${new Date(c.followUpDate).toLocaleDateString()}</span>
        </div>`).join('')
      : `<p style="color:var(--text-muted);font-size:0.875rem">No follow-ups overdue 🎉</p>`;

    // Reply sentiment breakdown
    const sc = d.sentimentCounts || {};
    const SENT_ROWS = [
      { k:'interested',     label:'🔥 Interested', col:'#16a34a' },
      { k:'question',       label:'❔ Question',    col:'#2563eb' },
      { k:'not_now',        label:'🕒 Not now',     col:'#d97706' },
      { k:'not_interested', label:'✕ Declined',    col:'#ef4444' }
    ];
    const sentTotal = SENT_ROWS.reduce((a, r) => a + (sc[r.k] || 0), 0);
    const sentimentHtml = sentTotal === 0
      ? `<p style="color:var(--text-muted);font-size:0.85rem">No replies classified yet.</p>`
      : SENT_ROWS.map(r => {
          const n = sc[r.k] || 0;
          const pct = sentTotal ? Math.round((n / sentTotal) * 100) : 0;
          return `<div style="display:flex;align-items:center;gap:10px;padding:6px 0">
            <span style="width:110px;font-size:0.82rem">${r.label}</span>
            <div style="flex:1;background:var(--border);border-radius:4px;height:8px"><div style="width:${pct}%;background:${r.col};height:8px;border-radius:4px"></div></div>
            <span style="width:28px;text-align:right;font-weight:600;color:${r.col}">${n}</span>
          </div>`;
        }).join('');

    el.innerHTML = `
      <!-- KPI strip -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:16px;margin-bottom:24px">
        ${[
          { label:'Total Candidates', value: d.total, color:'#2563eb' },
          { label:'Response Rate',    value: d.responseRate+'%', color:'#7c3aed' },
          { label:'Email Open Rate',  value: d.openRate+'%', color:'#0891b2' },
          { label:'Avg Days Active',  value: d.avgDays+'d', color:'#d97706' },
          { label:'Unread Replies',   value: d.unreadCount, color: d.unreadCount>0?'#ef4444':'#16a34a' },
          { label:'Follow-Ups Due',   value: d.followUpsDue, color: d.followUpsDue>0?'#f97316':'#16a34a' },
          { label:'Auto Follow-Ups Queued', value: d.pendingFollowUps||0, color:'#6366f1' }
        ].map(k => `
          <div class="settings-card" style="margin:0">
            <div class="settings-card-body" style="text-align:center;padding:16px 12px">
              <div style="font-size:1.8rem;font-weight:700;color:${k.color}">${k.value}</div>
              <div style="font-size:0.75rem;color:var(--text-muted);margin-top:4px">${k.label}</div>
            </div>
          </div>`).join('')}
      </div>

      <!-- Stage breakdown -->
      <div class="settings-card">
        <div class="settings-card-header"><h3>Pipeline Breakdown</h3></div>
        <div class="settings-card-body">${stageRows}</div>
      </div>

      <!-- Reply sentiment + subject performance -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div class="settings-card" style="margin:0">
          <div class="settings-card-header"><h3>Reply Sentiment</h3><span class="settings-card-hint">Auto-classified inbound replies</span></div>
          <div class="settings-card-body">${sentimentHtml}</div>
        </div>
        <div class="settings-card" style="margin:0">
          <div class="settings-card-header"><h3>Subject Lines by Open Rate</h3><span class="settings-card-hint">Which subjects get opened</span></div>
          <div class="settings-card-body" id="subject-leaderboard"><p style="color:var(--text-muted);font-size:0.85rem">Loading…</p></div>
        </div>
      </div>

      <!-- Follow-ups due -->
      <div class="settings-card">
        <div class="settings-card-header">
          <h3>⏰ Follow-Ups Due <span style="font-size:0.8rem;font-weight:400;color:var(--text-muted)">(${d.followUpsDue})</span></h3>
        </div>
        <div class="settings-card-body">${followUpHtml}</div>
      </div>
    `;

    // Subject leaderboard (separate call — works retroactively on existing sends)
    API.analytics.subjects().then(({ subjects }) => {
      const lb = document.getElementById('subject-leaderboard');
      if (!lb) return;
      if (!subjects || !subjects.length) { lb.innerHTML = `<p style="color:var(--text-muted);font-size:0.85rem">No outreach sent yet.</p>`; return; }
      lb.innerHTML = subjects.map(s => {
        const col = s.openRate >= 50 ? '#16a34a' : s.openRate >= 25 ? '#d97706' : '#ef4444';
        return `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)">
          <span style="flex:1;font-size:0.82rem;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(s.subject)}">${escapeHtml(s.subject)}</span>
          <span style="font-size:0.74rem;color:var(--text-muted);white-space:nowrap">${s.opened}/${s.sent}</span>
          <span style="font-weight:700;color:${col};min-width:42px;text-align:right">${s.openRate}%</span>
        </div>`;
      }).join('');
    }).catch(() => {});
  } catch (err) {
    el.innerHTML = `<div style="padding:40px;text-align:center;color:#ef4444">Failed to load analytics: ${err.message}</div>`;
  }
}

// ---- Settings ----
function initSettingsPage() {
  // ── Tab switching — CSS class-based, no inline style juggling ──
  const tabBtns   = Array.from(document.querySelectorAll('.settings-tab-btn'));
  const tabPanels = Array.from(document.querySelectorAll('.settings-tab-panel'));
  const scrollEl  = document.querySelector('.settings-scroll');

  function activateTab(tabName) {
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
    tabPanels.forEach(p => p.classList.toggle('active', p.dataset.panel === tabName));
    // Scroll back to top when switching tabs
    if (scrollEl) scrollEl.scrollTop = 0;
    try { localStorage.setItem('settings-tab', tabName); } catch (_) {}
  }

  const savedTab = (() => { try { return localStorage.getItem('settings-tab'); } catch (_) { return null; } })();
  const startTab = (savedTab && tabBtns.some(b => b.dataset.tab === savedTab)) ? savedTab : 'account';
  activateTab(startTab);

  tabBtns.forEach(btn => btn.addEventListener('click', () => activateTab(btn.dataset.tab)));

  // ── Enrichment API keys save button ──────────────────────────────────────
  document.getElementById('enrichment-save-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('enrichment-save-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const coVal  = document.getElementById('enrichment-contactout-key')?.value.trim() || '';
      const apVal  = document.getElementById('enrichment-apollo-key')?.value.trim()     || '';
      const huVal  = document.getElementById('profile-hunter-key')?.value.trim()        || '';
      await API.settings.update({
        ...(coVal ? { contactOutApiKey: coVal } : {}),
        ...(apVal ? { apolloApiKey:     apVal } : {}),
        ...(huVal ? { hunterApiKey:     huVal } : {})
      });
      Toast.success('API keys saved');
    } catch (err) { Toast.error(err.message); }
    finally { btn.disabled = false; btn.textContent = 'Save API Keys'; }
  });

  document.getElementById('connect-gmail-btn').addEventListener('click', async () => {
    try {
      const { url } = await API.email.getConnectUrl();
      window.location.href = url;
    } catch (err) { Toast.error('Failed to start Gmail connection: ' + err.message); }
  });

  document.getElementById('disconnect-gmail-btn').addEventListener('click', async () => {
    const ok = await showConfirm('Disconnect Gmail? You will need to reconnect to send emails.', 'Disconnect Gmail');
    if (!ok) return;
    try {
      await API.settings.disconnectGmail();
      if (currentUser) currentUser.gmail = { connected: false, address: '' };
      Toast.success('Gmail disconnected');
      updateGmailStatus();
    } catch (err) { Toast.error(err.message); }
  });

  document.getElementById('test-email-btn').addEventListener('click', async () => {
    const btn = document.getElementById('test-email-btn');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      await API.email.test();
      Toast.success('Test email sent to your inbox');
    } catch (err) { Toast.error(err.message); }
    finally { btn.disabled = false; btn.textContent = 'Send Test Email'; }
  });

  // ── Zoho Mail ────────────────────────────────────────────────────────────────
  document.getElementById('connect-zoho-btn').addEventListener('click', async () => {
    const btn = document.getElementById('connect-zoho-btn');
    btn.disabled = true; btn.textContent = 'Redirecting…';
    try {
      const { url } = await API.settings.getZohoConnectUrl();
      window.location.href = url;
    } catch (err) {
      Toast.error(err.message);
      btn.disabled = false; btn.textContent = 'Connect Zoho';
    }
  });

  document.getElementById('disconnect-zoho-btn').addEventListener('click', async () => {
    const ok = await showConfirm('Disconnect Zoho Mail?', 'Disconnect Zoho');
    if (!ok) return;
    try {
      await API.settings.disconnectZoho();
      Toast.success('Zoho Mail disconnected');
      updateZohoStatus();
    } catch (err) { Toast.error(err.message); }
  });

  document.getElementById('test-zoho-btn').addEventListener('click', async () => {
    const btn = document.getElementById('test-zoho-btn');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      await API.email.test();
      Toast.success('Test email sent to your Zoho inbox');
    } catch (err) { Toast.error(err.message); }
    finally { btn.disabled = false; btn.textContent = 'Send Test Email'; }
  });

  // ── Outlook ─────────────────────────────────────────────────────────────────
  document.getElementById('connect-outlook-btn').addEventListener('click', async () => {
    const btn = document.getElementById('connect-outlook-btn');
    btn.disabled = true; btn.textContent = 'Redirecting…';
    try {
      const { url } = await API.settings.getOutlookConnectUrl();
      window.location.href = url;
    } catch (err) {
      Toast.error(err.message);
      btn.disabled = false; btn.textContent = 'Connect Outlook';
    }
  });

  document.getElementById('disconnect-outlook-btn').addEventListener('click', async () => {
    const ok = await showConfirm('Disconnect Outlook?', 'Disconnect');
    if (!ok) return;
    try {
      await API.settings.disconnectOutlook();
      Toast.success('Outlook disconnected');
      updateOutlookStatus();
    } catch (err) { Toast.error(err.message); }
  });

  document.getElementById('test-outlook-btn').addEventListener('click', async () => {
    const btn = document.getElementById('test-outlook-btn');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      await API.email.test();
      Toast.success('Test email sent to your Outlook inbox');
    } catch (err) { Toast.error(err.message); }
    finally { btn.disabled = false; btn.textContent = 'Send Test Email'; }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // DELIVERABILITY DASHBOARD
  // ════════════════════════════════════════════════════════════════════════════

  // ── ① Content Score ────────────────────────────────────────────────────────
  function analyzeEmailContent(subject, body) {
    const issues = [];
    let score = 100;

    const flag = (sev, text, deduct) => { issues.push({ sev, text }); score -= deduct; };

    const subj = subject || '';
    const bod  = body    || '';
    const subjL = subj.toLowerCase();
    const bodL  = bod.toLowerCase();

    // ── Subject checks ───────────────────────────────────────────────────────
    if (subj.length > 70)          flag('warning', `Subject is ${subj.length} chars — keep under 70 to avoid being cut off`, 5);
    if (/[A-Z]{4,}/.test(subj))    flag('error',   'ALL CAPS word in subject line — strong spam signal', 15);
    if (/[!]{2,}/.test(subj))      flag('error',   'Multiple exclamation marks in subject line', 10);
    if (/[$%]/.test(subj))         flag('warning',  'Dollar or percent sign in subject — common spam pattern', 10);
    if (/^(re:|fw:|fwd:)/i.test(subj) && !subj.match(/^re:\s+\w/i)) flag('warning', 'Fake Re:/Fwd: prefix looks deceptive to filters', 8);

    // ── Body checks ──────────────────────────────────────────────────────────
    const words     = bod.split(/\s+/).filter(Boolean);
    const capsWords = words.filter(w => w.length > 3 && w === w.toUpperCase() && /[A-Z]/.test(w));
    if (capsWords.length > 2) flag('warning', `${capsWords.length} ALL CAPS words in body (${capsWords.slice(0,3).join(', ')}) — reduce to 0`, 8);

    const bangs = (bod.match(/!/g) || []).length;
    if (bangs > 2)  flag('warning', `${bangs} exclamation marks — keep to 1 or fewer in professional email`, Math.min(12, (bangs - 2) * 4));

    const links = (bod.match(/https?:\/\//g) || []).length;
    if (links > 3)  flag('warning', `${links} links detected — more than 3 raises spam probability`, links > 5 ? 15 : 8);

    const dollars = (bod.match(/\$/g) || []).length;
    if (dollars > 2) flag('warning', `${dollars} dollar signs — where possible use "six-figure" instead of exact amounts`, 6);

    if (bod.length < 150) flag('warning', 'Very short email body — may trigger phishing detection', 8);
    if (bod.length > 3000) flag('warning', 'Very long email body — keep outreach under ~500 words', 5);

    // Spam trigger words — context-tuned for professional recruiting
    const SPAM_WORDS = [
      ['click here',        12], ['act now',          12], ['limited time',     10],
      ['urgent',             8], ['guaranteed',       10], ['make money',       12],
      ['risk free',         10], ['no obligation',     8], ['special offer',    10],
      ['earn money',        12], ['cash bonus',       10], ['buy now',          12],
      ['order now',         12], ['dear friend',       8], ['this is not spam',15],
      ['not junk',          12], ['while supplies',    8], ['you have been selected', 12],
      ['congratulations',    6], ['double your',       8], ['100% free',        12],
      ['no cost',            6], ['winner',            8], ['prize',             8],
    ];
    for (const [word, penalty] of SPAM_WORDS) {
      if (subjL.includes(word)) flag('error',   `Spam trigger word in subject: "${word}"`, penalty + 4);
      else if (bodL.includes(word)) flag('error', `Spam trigger word in body: "${word}"`, penalty);
    }

    // ── Positive signals ─────────────────────────────────────────────────────
    const positives = [];
    if (!/<script/i.test(bod))                       positives.push('No script tags');
    if (bod.length >= 200 && bod.length <= 2000)     positives.push('Good email length');
    if (capsWords.length === 0)                      positives.push('No ALL CAPS words');
    if (bangs <= 1)                                  positives.push('Minimal exclamation marks');
    if (links <= 2)                                  positives.push('Low link count');
    if (!SPAM_WORDS.some(([w]) => bodL.includes(w))) positives.push('No spam trigger words found');

    score = Math.max(0, Math.round(score));

    return { score, issues, positives };
  }

  document.getElementById('content-score-btn').addEventListener('click', () => {
    const subject = document.getElementById('cs-subject').value.trim();
    const body    = document.getElementById('cs-body').value.trim();
    const resultEl = document.getElementById('cs-result');

    // Fall back to standard outreach template if fields are empty
    const analyzeSubject = subject || 'Something Worth a Few Minutes of Your Time';
    const analyzeBody    = body    || `Dear [First Name],\n\nYour career reflects something most professionals in this field never develop — a genuine combination of operational depth, strategic perspective, and direct experience built across multiple environments over time.\n\n[Your company pitch paragraph will appear here — fill in Company Pitch in Settings → Account to customise this.]\n\nWe're looking for professionals who understand what it takes to lead at this level — not just support from the outside. There is one part of what we are building right now that I kept out of this email on purpose — the kind of detail that is easier to show than describe. If any part of this caught your attention, reply here and I will send it over. No calls to schedule, no commitments — just a reply.\n\n[Your Name]\n[Your Title]`;

    const { score, issues, positives } = analyzeEmailContent(analyzeSubject, analyzeBody);

    const scoreColor = score >= 85 ? '#15803d' : score >= 65 ? '#d97706' : '#b91c1c';
    const scoreBg    = score >= 85 ? '#f0fdf4' : score >= 65 ? '#fffbeb' : '#fef2f2';
    const scoreBorder= score >= 85 ? '#86efac' : score >= 65 ? '#fcd34d' : '#fca5a5';
    const scoreLabel = score >= 85 ? 'Good' : score >= 65 ? 'Needs work' : 'High risk';
    const barWidth   = score + '%';

    const issueHtml = issues.length
      ? issues.map(i => `<div style="display:flex;gap:8px;align-items:flex-start;padding:4px 0">
          <span style="flex-shrink:0;color:${i.sev === 'error' ? '#ef4444' : '#f59e0b'}">${i.sev === 'error' ? '●' : '◐'}</span>
          <span style="font-size:0.8rem;color:#374151">${i.text}</span>
        </div>`).join('')
      : '';

    const posHtml = positives.map(p =>
      `<div style="display:flex;gap:8px;align-items:center;padding:3px 0">
         <span style="color:#22c55e;flex-shrink:0">✓</span>
         <span style="font-size:0.8rem;color:#374151">${p}</span>
       </div>`).join('');

    resultEl.style.display = 'block';
    resultEl.innerHTML = `
      <div style="padding:14px 16px;border-radius:10px;background:${scoreBg};border:1px solid ${scoreBorder}">
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:10px">
          <div style="font-size:2rem;font-weight:800;color:${scoreColor};line-height:1">${score}</div>
          <div>
            <div style="font-size:0.9rem;font-weight:600;color:${scoreColor}">${scoreLabel}</div>
            <div style="font-size:0.75rem;color:#64748b">out of 100${!subject && !body ? ' — standard outreach template' : ''}</div>
          </div>
          <div style="flex:1;height:8px;background:#e2e8f0;border-radius:4px;overflow:hidden;margin-left:auto;max-width:140px">
            <div style="height:100%;width:${barWidth};background:${scoreColor};border-radius:4px;transition:width .4s"></div>
          </div>
        </div>
        ${issues.length ? `<div style="margin-bottom:8px">${issueHtml}</div>` : ''}
        ${positives.length ? `<div>${posHtml}</div>` : ''}
      </div>`;
  });

  // ── ② Inbox / Spam Test ────────────────────────────────────────────────────
  // Save secondary email
  document.getElementById('save-secondary-btn').addEventListener('click', async () => {
    const email = document.getElementById('secondary-test-email').value.trim();
    const btn = document.getElementById('save-secondary-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await API.settings.update({ secondaryTestEmail: email });
      Toast.success(email ? 'Secondary inbox saved' : 'Secondary inbox cleared');
    } catch (err) { Toast.error(err.message); }
    finally { btn.disabled = false; btn.textContent = 'Save'; }
  });

  document.getElementById('deliverability-run-btn').addEventListener('click', async () => {
    const btn          = document.getElementById('deliverability-run-btn');
    const resultBox    = document.getElementById('deliverability-result');
    const statusEl     = document.getElementById('deliverability-status');
    const tipsEl       = document.getElementById('deliverability-tips');
    const secNote      = document.getElementById('deliverability-secondary-note');
    const inclSecondary= document.getElementById('include-secondary-cb').checked;

    btn.disabled = true; btn.textContent = 'Sending…';
    resultBox.style.display = 'none'; secNote.style.display = 'none';

    let threadId, sends = [], mailtesterName = null;
    try {
      const res = await API.email.deliverabilityTest({ includeSecondary: inclSecondary });
      threadId = res.threadId; sends = res.sends || []; mailtesterName = res.mailtesterName;
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Send Test Emails';
      Toast.error('Could not send test: ' + err.message); return;
    }

    btn.textContent = 'Checking Gmail…';
    resultBox.style.display = 'block';
    statusEl.style.cssText = 'display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:10px;background:#f0f9ff;border:1px solid #bae6fd;color:#0369a1;font-size:0.875rem;font-weight:500';
    statusEl.innerHTML = '<span style="font-size:1.3rem">🔍</span> Waiting for Gmail to deliver the test message…';
    tipsEl.innerHTML = '';

    // Show secondary note immediately if sent
    const secSend = sends.find(s => s.label === 'Secondary inbox');
    if (secSend) {
      secNote.style.display = 'block';
      const domain = secSend.to.split('@')[1] || 'your secondary inbox';
      secNote.innerHTML = `📬 <strong>Secondary inbox:</strong> Test sent to <strong>${secSend.to}</strong> — check both <em>Inbox</em> and <em>Spam/Junk</em> in ${domain} manually. This gives you a cross-provider signal Gmail can't tell you.`;
    }

    let attempts = 0; const maxAttempts = 14;
    const poll = setInterval(async () => {
      attempts++;
      try {
        const r = await API.email.deliverabilityResult(threadId);
        if (r.result === 'pending' && attempts < maxAttempts) return;

        clearInterval(poll);
        btn.disabled = false; btn.textContent = 'Send Test Emails';

        const configs = {
          inbox: { bg:'#f0fdf4', border:'#86efac', color:'#15803d', icon:'✅', label:'Landed in Gmail Inbox', sub:'Your Gmail deliverability looks good.', tips: '• Keep using the 3–8 min delay between bulk sends<br>• Use personalised subject lines and first names<br>• Monitor open rates — a drop can signal reputation issues' },
          tabs:  { bg:'#fffbeb', border:'#fcd34d', color:'#92400e', icon:'📂', label:'Landed in Promotions / Updates tab', sub:"Not spam, but not the main inbox either.", tips: '• Remove or reduce links in outreach emails<br>• Avoid marketing-style language and HTML formatting<br>• Ask recipients to reply — engagement signals move you to Primary<br>• Reduce image count in your signature' },
          spam:  { bg:'#fef2f2', border:'#fca5a5', color:'#b91c1c', icon:'🚨', label:'Landed in Spam', sub:'Emails are being filtered before recipients see them.', tips: '<strong>Common causes:</strong><br>• Sending volume too high — use the 3–8 min delay<br>• New Gmail account — warm it up with normal emails first<br>• Spam trigger words in body or subject — run the Content Score above<br>• No prior relationship with recipients<br><br><strong>Immediate actions:</strong> Reduce batch size, increase delay, check content score.' },
        };
        const cfg = configs[r.result] || { bg:'#f8fafc', border:'#e2e8f0', color:'#64748b', icon:'⏳', label: attempts >= maxAttempts ? 'Timed out — Gmail still processing' : 'Result unclear', sub:'Try again in a minute.', tips:'' };

        statusEl.style.cssText = `display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:10px;background:${cfg.bg};border:1px solid ${cfg.border};color:${cfg.color};font-size:0.875rem;font-weight:600`;
        statusEl.innerHTML = `<span style="font-size:1.5rem">${cfg.icon}</span><div><div>${cfg.label}</div><div style="font-weight:400;font-size:0.78rem;margin-top:2px;opacity:.85">${cfg.sub}</div></div>`;
        tipsEl.innerHTML = cfg.tips ? `<div style="font-size:0.8rem;color:#475569;line-height:1.8;padding:10px 14px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0">${cfg.tips}</div>` : '';
      } catch { if (attempts >= maxAttempts) { clearInterval(poll); btn.disabled = false; btn.textContent = 'Send Test Emails'; } }
    }, 5000);
  });

  // ── ③ Mail-Tester ──────────────────────────────────────────────────────────
  document.getElementById('mailtester-send-btn').addEventListener('click', async () => {
    const addr   = document.getElementById('mailtester-address').value.trim();
    const btn    = document.getElementById('mailtester-send-btn');
    const status = document.getElementById('mailtester-status');

    if (!addr || !addr.includes('@')) { Toast.warning('Paste a valid mail-tester.com address first'); return; }

    btn.disabled = true; btn.textContent = 'Sending…';
    status.style.display = 'none';

    try {
      const res = await API.email.deliverabilityTest({ mailtesterAddress: addr });
      const testName = res.mailtesterName || addr.split('@')[0];
      const resultsUrl = `https://www.mail-tester.com/${testName}`;

      status.style.display = 'block';
      status.innerHTML = `
        <div style="padding:12px 14px;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;color:#15803d;font-weight:600;margin-bottom:8px">
          ✅ Test email sent to mail-tester.com
        </div>
        <p style="font-size:0.8rem;color:#475569;margin:0 0 10px">Wait 30–60 seconds for their servers to process it, then click below to see your full report — SpamAssassin score, blacklists, SPF/DKIM/DMARC, HTML ratio, and more.</p>
        <a href="${resultsUrl}" target="_blank"
           style="display:inline-flex;align-items:center;gap:8px;background:#1a3e72;color:#fff;padding:9px 18px;border-radius:7px;font-size:0.85rem;font-weight:600;text-decoration:none">
          View Full Report on Mail-Tester →
        </a>`;
    } catch (err) {
      Toast.error('Send failed: ' + err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Send to Mail-Tester';
    }
  });

  document.getElementById('profile-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const hunterField = document.getElementById('profile-hunter-key');
      const data = {
        name: document.getElementById('profile-name').value.trim(),
        title: document.getElementById('profile-title').value.trim(),
        companyName: document.getElementById('profile-company-name').value.trim(),
        companyPitch: document.getElementById('profile-company-pitch').value.trim(),
        salaryRange: (document.getElementById('profile-salary-range') || {value:''}).value.trim(),
        ...(hunterField && hunterField.value.trim() !== '••••••••' ? { hunterApiKey: hunterField.value.trim() } : {})
      };
      await API.settings.update(data);
      if (currentUser) {
        if (data.name) currentUser.name = data.name;
        currentUser.title = data.title;
        currentUser.companyName = data.companyName;
        currentUser.companyPitch = data.companyPitch;
      }
      // Update sidebar company name live
      const _sbn = document.getElementById('sidebar-company-name');
      if (_sbn) _sbn.textContent = data.companyName || 'Recruit Pro';
      document.getElementById('sidebar-user-name').textContent = data.name || currentUser.name;
      Toast.success('Profile saved');
    } catch (err) { Toast.error(err.message); }
    finally { btn.disabled = false; btn.textContent = 'Save Profile'; }
  });

  // Resume consultant partner form
  const partnerFormEl = document.getElementById('partner-form');
  if (partnerFormEl) {
    partnerFormEl.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = e.target.querySelector('[type=submit]');
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const pn = document.getElementById('partner-name').value.trim();
        const pe = document.getElementById('partner-email').value.trim();
        await API.settings.update({ resumeConsultantName: pn, resumeConsultantEmail: pe });
        if (currentUser) {
          currentUser.resumeConsultantName  = pn;
          currentUser.resumeConsultantEmail = pe;
        }
        Toast.success('Partner saved');
      } catch (err) { Toast.error(err.message); }
      finally { btn.disabled = false; btn.textContent = 'Save Partner'; }
    });
  }

  document.getElementById('style-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const data = {
        tone: document.getElementById('style-tone').value,
        notes: document.getElementById('style-notes').value.trim(),
        use: document.getElementById('style-use').value.split(',').map(s => s.trim()).filter(Boolean),
        avoid: document.getElementById('style-avoid').value.split(',').map(s => s.trim()).filter(Boolean)
      };
      await API.settings.update(data);
      if (currentUser) currentUser.style = data;
      Toast.success('Style settings saved');
    } catch (err) { Toast.error(err.message); }
    finally { btn.disabled = false; btn.textContent = 'Save Settings'; }
  });

  document.getElementById('colleague-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      await API.settings.addColleague({
        name: document.getElementById('col-name').value.trim(),
        email: document.getElementById('col-email').value.trim(),
        password: document.getElementById('col-password').value
      });
      Toast.success('Colleague account created');
      e.target.reset();
    } catch (err) { Toast.error(err.message); }
    finally { btn.disabled = false; btn.textContent = 'Create Account'; }
  });

  // ── Signature form ──────────────────────────────────────────────────────────
  document.getElementById('signature-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await API.settings.update({
        signature: {
          enabled:    document.getElementById('sig-enabled').checked,
          photoUrl:   document.getElementById('sig-photo').value.trim(),
          website:    document.getElementById('sig-website').value.trim(),
          location:   document.getElementById('sig-location').value.trim(),
          linkedin:   document.getElementById('sig-linkedin').value.trim(),
          facebook:   document.getElementById('sig-facebook').value.trim(),
          twitter:    document.getElementById('sig-twitter').value.trim(),
          disclaimer: document.getElementById('sig-disclaimer').value.trim()
        }
      });
      Toast.success('Signature saved');
    } catch (err) { Toast.error(err.message); }
    finally { btn.disabled = false; btn.textContent = 'Save Signature'; }
  });

  document.getElementById('sig-photo-upload').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const status = document.getElementById('sig-photo-status');
    const preview = document.getElementById('sig-photo-preview');
    const img = document.getElementById('sig-photo-img');
    status.textContent = 'Uploading…';
    preview.style.display = 'flex';
    preview.style.alignItems = 'center';
    try {
      const fd = new FormData();
      fd.append('photo', file);
      const res = await fetch('/api/settings/signature/upload-photo', { method: 'POST', body: fd });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      document.getElementById('sig-photo').value = data.url;
      img.src = data.url;
      status.textContent = 'Uploaded ✓';
      status.style.color = '#16a34a';
    } catch (err) {
      status.textContent = 'Upload failed: ' + err.message;
      status.style.color = '#ef4444';
    }
  });

  // Show preview thumbnail if URL is already set
  const existingPhoto = document.getElementById('sig-photo').value;
  if (existingPhoto) {
    document.getElementById('sig-photo-img').src = existingPhoto;
    document.getElementById('sig-photo-preview').style.display = 'flex';
    document.getElementById('sig-photo-preview').style.alignItems = 'center';
  }

  document.getElementById('sig-linkedin-fill-btn').addEventListener('click', async () => {
    const url = document.getElementById('sig-linkedin-import').value.trim();
    const msg = document.getElementById('sig-linkedin-fill-msg');
    const btn = document.getElementById('sig-linkedin-fill-btn');
    if (!url) { msg.style.display='block'; msg.style.color='#ef4444'; msg.textContent='Paste a LinkedIn profile URL first.'; return; }
    btn.disabled = true; btn.textContent = 'Loading…';
    msg.style.display = 'none';
    try {
      const data = await fetch('/api/settings/signature/linkedin-prefill', {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ url })
      }).then(r => r.json());
      if (data.error) throw new Error(data.error);
      if (data.name)     { document.getElementById('profile-name').value    = data.name; }
      if (data.title)    { document.getElementById('profile-title').value   = data.title; }
      if (data.company)  { document.getElementById('profile-company-name').value = data.company; }
      if (data.photo)    { document.getElementById('sig-photo').value       = data.photo; }
      if (data.location) { document.getElementById('sig-location').value    = data.location; }
      if (url)           { document.getElementById('sig-linkedin').value    = url; }
      msg.style.display='block'; msg.style.color='#16a34a';
      msg.textContent = `Filled in: ${[data.name, data.title, data.company].filter(Boolean).join(' · ')}. Review and save.`;
    } catch(err) {
      msg.style.display='block'; msg.style.color='#ef4444'; msg.textContent = err.message;
    } finally {
      btn.disabled = false; btn.textContent = 'Fill from LinkedIn';
    }
  });

  document.getElementById('sig-preview-btn').addEventListener('click', () => {
    const box     = document.getElementById('sig-preview-box');
    const content = document.getElementById('sig-preview-content');
    const name    = document.getElementById('profile-name').value.trim()  || (currentUser && currentUser.name) || 'Your Name';
    const title   = document.getElementById('profile-title').value.trim() || '';
    const company = document.getElementById('profile-company-name').value.trim();
    const photo   = document.getElementById('sig-photo').value.trim();
    const website = document.getElementById('sig-website').value.trim();
    const loc     = document.getElementById('sig-location').value.trim();
    const linkedin= document.getElementById('sig-linkedin').value.trim();
    const facebook= document.getElementById('sig-facebook').value.trim();
    const twitter = document.getElementById('sig-twitter').value.trim();
    const disc    = document.getElementById('sig-disclaimer').value.trim();

    const photoBlock = photo
      ? `<td width="108" style="padding-right:14px;vertical-align:middle"><img src="${photo}" width="90" height="90" alt="${name}" style="display:block;border-radius:50%;width:90px;height:90px;object-fit:cover"></td>`
      : '';

    const nameBlock = title
      ? `<p style="margin:0;font-size:20px;font-weight:700;color:#111111;font-family:Arial,sans-serif;line-height:1.2">${name}</p>
         <p style="margin:5px 0 0;font-size:15px;color:#444444;font-family:Arial,sans-serif;line-height:1.4">${title}</p>
         ${company ? `<p style="margin:3px 0 0;font-size:15px;color:#444444;font-family:Arial,sans-serif;line-height:1.4">${company}</p>` : ''}`
      : `<p style="margin:0;font-size:20px;font-weight:700;color:#111111;font-family:Arial,sans-serif;line-height:1.2">${name}</p>
         ${company ? `<p style="margin:5px 0 0;font-size:15px;color:#444444;font-family:Arial,sans-serif;line-height:1.4">${company}</p>` : ''}`;

    const websiteLine  = website ? `<p style="margin:0 0 5px;font-size:13px;color:#444444;font-family:Arial,sans-serif">🌐&nbsp;<a href="${website}" style="color:#444444;text-decoration:none">${website.replace(/^https?:\/\//, '')}</a></p>` : '';
    const locationLine = loc     ? `<p style="margin:0 0 5px;font-size:13px;color:#444444;font-family:Arial,sans-serif">📍&nbsp;${loc}</p>` : '';

    const pillBtn = (href, bg, label) => href
      ? `<a href="${href}" target="_blank" style="display:inline-block;background-color:${bg};color:#ffffff;text-decoration:none;font-family:Arial,sans-serif;font-size:12px;font-weight:700;padding:7px 16px;border-radius:20px;margin-right:8px;line-height:1">${label}</a>`
      : '';
    const socialPills = [pillBtn(linkedin,'#0A66C2','in  LinkedIn'), pillBtn(facebook,'#1877F2','f  Facebook'), pillBtn(twitter,'#1a1a1a','X  Twitter')].filter(Boolean).join('');
    const socialBlock = socialPills ? `<p style="margin:0 0 14px">${socialPills}</p>` : '';

    const visitBtn = website
      ? `<a href="${website}" target="_blank" style="display:inline-block;padding:8px 24px;border:1.5px solid #333333;border-radius:6px;color:#333333;text-decoration:none;font-family:Arial,sans-serif;font-size:13px;font-weight:500;margin-bottom:14px">Visit Website</a>`
      : '';

    const discHtml = disc
      ? `<p style="margin:0;font-size:11px;color:#888888;line-height:1.6;font-family:Arial,sans-serif;max-width:560px">${disc}</p>`
      : '';

    content.innerHTML = `
      <div style="font-family:Arial,sans-serif;max-width:600px;width:100%">
        <p style="margin:0 0 14px;font-family:'Dancing Script',cursive;font-size:30px;color:#2d2d2d;line-height:1;font-weight:600">Sincerely</p>
        <table border="0" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:14px;width:100%">
          <tr>
            ${photoBlock}
            <td style="vertical-align:middle">
              ${nameBlock}
            </td>
          </tr>
        </table>
        <hr style="border:none;border-top:1px solid #dddddd;margin:0 0 14px">
        ${websiteLine}
        ${locationLine}
        <div style="height:8px"></div>
        ${socialBlock}
        ${visitBtn}
        ${discHtml}
      </div>`;
    box.style.display = 'block';
  });
}

// ================================================================
// TEMPLATES PAGE
// ================================================================

let _templates = [];

async function loadTemplatesPage() {
  const el = document.getElementById('templates-content');
  if (!el) return;
  el.innerHTML = `<div style="text-align:center;color:var(--text-muted);padding:40px">Loading…</div>`;
  try {
    _templates = await API.templates.list();
    renderTemplatesPage();
  } catch (err) {
    el.innerHTML = `<div style="color:#ef4444;padding:20px">Failed to load templates: ${err.message}</div>`;
  }
}

function renderTemplatesPage() {
  const el = document.getElementById('templates-content');
  if (!el) return;

  if (_templates.length === 0) {
    el.innerHTML = `<div style="text-align:center;padding:60px 20px">
      <div style="font-size:2.5rem;margin-bottom:12px">📝</div>
      <h3 style="color:var(--text);margin-bottom:8px">No templates yet</h3>
      <p style="color:var(--text-muted);font-size:0.9rem">Create reusable email templates with placeholders like {{firstName}}, {{company}}.</p>
      <button class="btn btn-primary btn-sm" style="margin-top:16px" onclick="openTemplateEditor()">+ Create First Template</button>
    </div>`;
    return;
  }

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px">
      ${_templates.map(t => `
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:10px">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
            <div>
              <div style="font-weight:600;color:var(--text);font-size:0.95rem">${escapeHtml(t.name)}</div>
              ${t.subject ? `<div style="font-size:0.8rem;color:var(--text-muted);margin-top:2px">Subject: ${escapeHtml(t.subject)}</div>` : ''}
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0">
              <button class="btn btn-ghost btn-sm tpl-edit-btn" data-id="${t.id}">Edit</button>
              <button class="btn btn-ghost btn-sm tpl-delete-btn" data-id="${t.id}" style="color:#ef4444">Delete</button>
            </div>
          </div>
          <div style="font-size:0.82rem;color:var(--text-muted);line-height:1.5;max-height:72px;overflow:hidden;white-space:pre-wrap">${escapeHtml((t.body || '').substring(0, 150))}${t.body && t.body.length > 150 ? '…' : ''}</div>
          <button class="btn btn-secondary btn-sm tpl-use-btn" data-id="${t.id}">Use in Compose →</button>
        </div>
      `).join('')}
    </div>
  `;

  el.querySelectorAll('.tpl-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => openTemplateEditor(_templates.find(t => t.id === btn.dataset.id)));
  });
  el.querySelectorAll('.tpl-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!await showConfirm('Delete this template?', 'Delete')) return;
      try {
        await API.templates.delete(btn.dataset.id);
        _templates = _templates.filter(t => t.id !== btn.dataset.id);
        renderTemplatesPage();
        Toast.success('Template deleted');
      } catch (err) { Toast.error(err.message); }
    });
  });
  el.querySelectorAll('.tpl-use-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      // Navigate to candidates page so user can pick a candidate
      navigateTo('candidates');
      Toast.show('Open a candidate → Thread tab → use the template dropdown to apply');
    });
  });
}

function openTemplateEditor(template = null) {
  document.getElementById('template-editor-id').value    = template ? template.id : '';
  document.getElementById('template-editor-title').textContent = template ? 'Edit Template' : 'New Template';
  document.getElementById('template-name').value    = template ? template.name    : '';
  document.getElementById('template-subject').value = template ? template.subject : '';
  document.getElementById('template-body').value    = template ? template.body    : '';
  new Modal('template-editor-modal').open();
}

function wireTemplateEditor() {
  document.getElementById('new-template-btn')?.addEventListener('click', () => openTemplateEditor());
  document.getElementById('template-editor-cancel')?.addEventListener('click', () => new Modal('template-editor-modal').close());
  document.getElementById('template-editor-modal').querySelector('.modal-close')?.addEventListener('click', () => new Modal('template-editor-modal').close());

  document.getElementById('template-editor-save')?.addEventListener('click', async () => {
    const id      = document.getElementById('template-editor-id').value;
    const name    = document.getElementById('template-name').value.trim();
    const subject = document.getElementById('template-subject').value.trim();
    const body    = document.getElementById('template-body').value.trim();
    if (!name)  { Toast.warning('Template name is required'); return; }
    if (!body)  { Toast.warning('Template body is required'); return; }
    const btn = document.getElementById('template-editor-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      if (id) {
        const updated = await API.templates.update(id, { name, subject, body });
        const idx = _templates.findIndex(t => t.id === id);
        if (idx >= 0) _templates[idx] = updated;
      } else {
        const created = await API.templates.create({ name, subject, body });
        _templates.push(created);
      }
      new Modal('template-editor-modal').close();
      renderTemplatesPage();
      Toast.success('Template saved');
    } catch (err) { Toast.error(err.message); }
    finally { btn.disabled = false; btn.textContent = 'Save Template'; }
  });
}

// ================================================================
// LINKEDIN IMPORT
// ================================================================

let _liParsed = null;

function wireLinkedInImport() {
  const btn = document.getElementById('linkedin-import-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    _liParsed = null;
    document.getElementById('li-url').value = '';
    document.getElementById('li-rawtext').value = '';
    document.getElementById('li-step-url').style.display = 'block';
    document.getElementById('li-step-paste').style.display = 'none';
    document.getElementById('li-preview').style.display = 'none';
    document.getElementById('li-import-btn').style.display = 'inline-flex';
    document.getElementById('li-confirm-btn').style.display = 'none';
    document.getElementById('li-paste-btn').style.display = 'none';
    document.getElementById('li-status').textContent = '';
    new Modal('linkedin-import-modal').open();
  });

  document.getElementById('li-cancel-btn')?.addEventListener('click', () => new Modal('linkedin-import-modal').close());
  document.getElementById('linkedin-import-modal').querySelector('.modal-close')?.addEventListener('click', () => new Modal('linkedin-import-modal').close());

  document.getElementById('li-paste-btn')?.addEventListener('click', () => {
    document.getElementById('li-step-paste').style.display = 'block';
    document.getElementById('li-paste-btn').style.display = 'none';
    document.getElementById('li-import-btn').textContent = 'Parse Profile';
  });

  document.getElementById('li-import-btn')?.addEventListener('click', async () => {
    const url     = document.getElementById('li-url').value.trim();
    const rawText = document.getElementById('li-rawtext').value.trim();
    if (!url && !rawText) { Toast.warning('Enter a LinkedIn URL or paste profile text'); return; }
    const btn = document.getElementById('li-import-btn');
    const statusEl = document.getElementById('li-status');
    btn.disabled = true; btn.textContent = 'Importing…'; statusEl.textContent = '';
    try {
      const result = await API.linkedin.import({ url, rawText: rawText || undefined });
      _liParsed = result;
      showLinkedInPreview(result);
    } catch (err) {
      if (err.message && err.message.includes('paste it')) {
        // LinkedIn blocked — show paste step
        document.getElementById('li-step-paste').style.display = 'block';
        document.getElementById('li-paste-btn').style.display = 'none';
        btn.textContent = 'Parse Profile';
        statusEl.textContent = 'LinkedIn blocked auto-import. Paste the profile text above.';
        statusEl.style.color = '#d97706';
      } else {
        Toast.error('Import failed: ' + err.message);
        btn.textContent = 'Import Profile';
      }
    }
    btn.disabled = false;
  });

  document.getElementById('li-confirm-btn')?.addEventListener('click', async () => {
    if (!_liParsed) return;
    try {
      // Use manual email override if provided, else fall back to parsed email
      const emailOverride = (document.getElementById('li-email-override')?.value || '').trim();
      const candidate = await API.candidates.create({
        name:       _liParsed.name || '',
        email:      emailOverride || _liParsed.personalEmail || _liParsed.email || '',
        title:      _liParsed.title || '',
        company:    _liParsed.company || '',
        phone:      _liParsed.phone || '',
        linkedin:   _liParsed.linkedin || '',
        summary:    _liParsed.summary || '',
        background: _liParsed.summary || ''
      });
      // Merge career history via update
      if (_liParsed.career && _liParsed.career.length > 0) {
        await API.candidates.update(candidate.id, { career: _liParsed.career, education: _liParsed.education || [] });
      }
      allCandidates.push({ ...candidate, career: _liParsed.career || [], education: _liParsed.education || [] });
      renderCandidates();
      renderTagFilterBar();
      new Modal('linkedin-import-modal').close();
      Toast.success(`${_liParsed.name || 'Candidate'} imported successfully!`);
    } catch (err) {
      if (err.status === 409 || (err.message && err.message.includes('already in your pipeline'))) {
        Toast.error('⚠️ ' + (err.message || 'This candidate is already in your pipeline.'));
      } else {
        Toast.error('Failed to add candidate: ' + err.message);
      }
    }
  });
}

function showLinkedInPreview(p) {
  const preview = document.getElementById('li-preview');
  const content = document.getElementById('li-preview-content');
  preview.style.display = 'block';
  // Build email/phone found row
  const emailFoundHtml = (() => {
    const rows = [];
    if (p.personalEmail) rows.push(`<div style="display:flex;align-items:center;gap:6px"><span style="font-size:0.7rem;background:#dcfce7;color:#166534;padding:1px 7px;border-radius:999px;font-weight:600">Personal</span><span style="font-weight:600;color:var(--green)">${escapeHtml(p.personalEmail)}</span>${p.emailSource ? `<span style="font-size:0.72rem;color:var(--text-faint)">via ${escapeHtml(p.emailSource)}</span>` : ''}</div>`);
    if (p.workEmail)     rows.push(`<div style="display:flex;align-items:center;gap:6px"><span style="font-size:0.7rem;background:#fef9c3;color:#854d0e;padding:1px 7px;border-radius:999px;font-weight:600">Work</span><span style="font-weight:500;color:var(--text)">${escapeHtml(p.workEmail)}</span></div>`);
    if (p.phone)         rows.push(`<div style="display:flex;align-items:center;gap:6px"><span style="font-size:0.7rem;background:#e0e7ff;color:#3730a3;padding:1px 7px;border-radius:999px;font-weight:600">Phone</span><span style="font-weight:500;color:var(--text)">${escapeHtml(p.phone)}</span></div>`);
    if (rows.length === 0) return `<div style="font-size:0.8rem;color:var(--text-muted)">No email found automatically — enter one below or add ContactOut / Apollo API keys in Settings.</div>`;
    return `<div style="display:flex;flex-direction:column;gap:5px">${rows.join('')}</div>`;
  })();

  content.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;font-size:0.855rem;margin-bottom:10px">
      <div><span style="color:var(--text-muted);font-size:0.75rem">Name</span><div style="font-weight:600;color:var(--text);margin-top:1px">${escapeHtml(p.name || '—')}</div></div>
      <div><span style="color:var(--text-muted);font-size:0.75rem">Company</span><div style="font-weight:600;color:var(--text);margin-top:1px">${escapeHtml(p.company || '—')}</div></div>
      <div><span style="color:var(--text-muted);font-size:0.75rem">Title</span><div style="font-weight:500;color:var(--text);margin-top:1px">${escapeHtml(p.title || '—')}</div></div>
      <div><span style="color:var(--text-muted);font-size:0.75rem">Location</span><div style="font-weight:500;color:var(--text);margin-top:1px">${escapeHtml(p.location || '—')}</div></div>
    </div>
    <div style="padding:10px 12px;background:var(--surface3);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:4px">${emailFoundHtml}</div>
    ${p.summary ? `<div style="margin-top:8px;font-size:0.8rem;color:var(--text-muted);line-height:1.5">${escapeHtml(p.summary.substring(0, 160))}${p.summary.length > 160 ? '…' : ''}</div>` : ''}
  `;

  // Pre-fill the email override with the best found email
  const emailField = document.getElementById('li-email-override');
  if (emailField) emailField.value = p.personalEmail || p.email || '';

  // Team duplicate check — warn if a teammate already has this person
  const bestEmail = p.personalEmail || p.workEmail || p.email || '';
  if (bestEmail) {
    API.email.teamDuplicateCheck([bestEmail]).then(({ matches }) => {
      const m = matches && matches[bestEmail.toLowerCase()];
      if (!m) return;
      const banner = document.createElement('div');
      banner.style.cssText = 'margin-top:8px;padding:8px 12px;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;font-size:0.8rem;color:#92400e';
      banner.innerHTML = `⚠ <strong>${escapeHtml(m.owner)}</strong> already has this person in their pipeline (${escapeHtml(m.stage)}). Importing may double-contact them.`;
      content.appendChild(banner);
    }).catch(() => {});
  }

  document.getElementById('li-import-btn').style.display = 'none';
  document.getElementById('li-confirm-btn').style.display = 'inline-flex';
  const statusEl = document.getElementById('li-status');
  const foundCount = [p.personalEmail, p.workEmail, p.phone].filter(Boolean).length;
  statusEl.textContent = foundCount > 0 ? `✓ Parsed — ${foundCount} contact detail${foundCount !== 1 ? 's' : ''} found` : '✓ Profile parsed';
  statusEl.style.color = foundCount > 0 ? 'var(--green)' : 'var(--text-muted)';
}

// ================================================================
// LINKEDIN BOOKMARKLET
// ================================================================

function buildBookmarkletLink() {
  const el = document.getElementById('li-bookmarklet-link');
  if (!el) return;
  const origin = window.location.origin;

  // ── Why popup + postMessage instead of fetch() ───────────────────────────
  // LinkedIn's strict Content-Security-Policy blocks all fetch() calls to
  // external domains (connect-src only allows *.linkedin.com). So we open a
  // popup on OUR domain — which has no such restriction — and relay the page
  // text via postMessage. The popup makes the same-origin API call instead.
  const code = `(function(){
    if(!location.href.includes('linkedin.com/in/')){alert('Open a LinkedIn profile page first, then click this bookmark.');return;}
    var btn=document.createElement('div');
    btn.style.cssText='position:fixed;top:16px;right:16px;z-index:99999;background:#3b5bdb;color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;font-family:sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.3);cursor:default';
    btn.textContent='⏳ Importing…';document.body.appendChild(btn);
    var url=location.href;
    var text=document.body.innerText;
    var coEmails=(function(){
      var seen={},out=[],RE=/[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}/g,IG=/@(linkedin\\.com|licdn\\.com|contactout\\.com|example\\.com|sentry\\.|w3\\.org)/i;
      function add(e){e=(e||'').toLowerCase().trim().replace(/[)>.,;]+$/,'');if(e&&/^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/.test(e)&&!IG.test(e)&&!seen[e]){seen[e]=1;out.push(e);}}
      function walk(r){if(!r||!r.querySelectorAll)return;r.querySelectorAll('a[href^="mailto:"]').forEach(function(a){add((a.getAttribute('href')||'').replace(/^mailto:/i,'').split('?')[0]);});((r.textContent||'').match(RE)||[]).forEach(add);r.querySelectorAll('*').forEach(function(el){if(el.shadowRoot)walk(el.shadowRoot);});}
      walk(document);return out;
    })();
    var origin='${origin}';
    var w=window.open(origin+'/li-capture','_blank','width=540,height=320,resizable=yes');
    if(!w){
      btn.style.background='#e03131';
      btn.textContent='❌ Pop-up blocked! Allow pop-ups for linkedin.com and try again.';
      setTimeout(function(){btn.remove();},6000);
      return;
    }
    function onMsg(evt){
      if(evt.origin!==origin)return;
      if(!evt.data||!evt.data.ready)return;
      window.removeEventListener('message',onMsg);
      w.postMessage({url:url,text:text,coEmails:coEmails},origin);
      btn.textContent='✔ Sent! Opening dashboard…';
      setTimeout(function(){btn.remove();},2500);
    }
    window.addEventListener('message',onMsg);
    setTimeout(function(){
      window.removeEventListener('message',onMsg);
      if(btn.parentNode){btn.style.background='#e03131';btn.textContent='❌ Timed out — please try again.';setTimeout(function(){btn.remove();},4000);}
    },20000);
  })()`;

  el.href = 'javascript:' + encodeURIComponent(code.replace(/\n\s+/g, ' ').trim());
  // Prevent the default link navigation when clicked (it should only be dragged)
  el.addEventListener('click', e => {
    e.preventDefault();
    Toast.show('Drag this button to your bookmarks bar — don\'t click it here');
  });
}

async function handleBookmarkletImport(token) {
  // Open the LinkedIn import modal and show a loading state
  _liParsed = null;
  document.getElementById('li-url').value = '';
  document.getElementById('li-rawtext').value = '';
  document.getElementById('li-step-url').style.display = 'block';
  document.getElementById('li-step-paste').style.display = 'none';
  document.getElementById('li-preview').style.display = 'none';
  document.getElementById('li-import-btn').style.display = 'none';
  document.getElementById('li-confirm-btn').style.display = 'none';
  document.getElementById('li-paste-btn').style.display = 'none';
  const statusEl = document.getElementById('li-status');
  statusEl.textContent = '⏳ Loading imported profile…';
  statusEl.style.color = 'var(--blue)';
  new Modal('linkedin-import-modal').open();

  try {
    const profile = await API.linkedin.bookmarkletResult(token);
    _liParsed = profile;
    if (profile.linkedin) document.getElementById('li-url').value = profile.linkedin;
    showLinkedInPreview(profile);
  } catch (err) {
    statusEl.textContent = '❌ ' + (err.message || 'Token expired — please run the bookmarklet again');
    statusEl.style.color = 'var(--red)';
    document.getElementById('li-import-btn').style.display = 'inline-flex';
  }
}

// ================================================================
// PUSH NOTIFICATIONS
// ================================================================

async function registerPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    const { publicKey } = await API.push.getVapidKey();
    if (!publicKey) return; // VAPID not configured on server

    const existing = await reg.pushManager.getSubscription();
    if (existing) return; // Already subscribed

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
    await API.push.subscribe(sub.toJSON());
    console.log('Push notifications enabled');
  } catch (err) {
    console.warn('Push registration failed:', err.message);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function loadSettingsPage() {
  try {
    const style = await API.settings.get();
    document.getElementById('profile-name').value = style.name || (currentUser && currentUser.name) || '';
    document.getElementById('profile-title').value = style.title || (currentUser && currentUser.title) || '';
    if (document.getElementById('profile-company-name'))  document.getElementById('profile-company-name').value  = style.companyName  || '';
    if (document.getElementById('profile-company-pitch')) document.getElementById('profile-company-pitch').value = style.companyPitch || '';
    if (document.getElementById('profile-salary-range'))  document.getElementById('profile-salary-range').value  = style.salaryRange  || '';
    if (document.getElementById('profile-hunter-key'))       document.getElementById('profile-hunter-key').value       = style.hunterApiKey     === '••••••••' ? '' : (style.hunterApiKey     || '');
    if (document.getElementById('enrichment-contactout-key')) document.getElementById('enrichment-contactout-key').value = style.contactOutApiKey === '••••••••' ? '' : (style.contactOutApiKey || '');
    if (document.getElementById('enrichment-apollo-key'))     document.getElementById('enrichment-apollo-key').value     = style.apolloApiKey     === '••••••••' ? '' : (style.apolloApiKey     || '');
    document.getElementById('style-tone').value = style.tone || 'warm';
    document.getElementById('style-notes').value = style.notes || '';
    document.getElementById('style-use').value = (style.use || []).join(', ');
    document.getElementById('style-avoid').value = (style.avoid || []).join(', ');

    // Secondary test inbox
    document.getElementById('secondary-test-email').value = style.secondaryTestEmail || '';

    // Signature fields
    const sig = style.signature || {};
    document.getElementById('sig-enabled').checked       = !!sig.enabled;
    document.getElementById('sig-photo').value           = sig.photoUrl   || '';
    document.getElementById('sig-website').value         = sig.website    || '';
    document.getElementById('sig-location').value        = sig.location   || '';
    document.getElementById('sig-linkedin').value        = sig.linkedin   || '';
    document.getElementById('sig-facebook').value        = sig.facebook   || '';
    document.getElementById('sig-twitter').value         = sig.twitter    || '';
    document.getElementById('sig-disclaimer').value      = sig.disclaimer || '';

    // Extension token
    const tokenEl = document.getElementById('extension-token-display');
    if (tokenEl && style.extensionToken) tokenEl.value = style.extensionToken;

    // Resume consultant partner (recruiters only)
    const partnerCard = document.getElementById('resume-partner-card');
    if (partnerCard) {
      const isRecruiter = (style.userType || currentUser.userType || '') !== 'career_consultant';
      partnerCard.style.display = isRecruiter ? '' : 'none';
      if (isRecruiter) {
        const pName  = document.getElementById('partner-name');
        const pEmail = document.getElementById('partner-email');
        if (pName)  pName.value  = style.resumeConsultantName  || '';
        if (pEmail) pEmail.value = style.resumeConsultantEmail || '';
      }
    }

    // Automated follow-up config
    renderFollowUpConfig(style.followUpConfig || { enabled: true, steps: [{ days: 3 }, { days: 7 }] });

    // Daily auto-outreach (autopilot) config
    renderAutopilotConfig(style.autopilot || {});

    // Outreach style sample
    renderOutreachSample(style.outreachSample || '', style.subjectSample || '');

    await updateGmailStatus();
    await updateZohoStatus();
    await updateOutlookStatus();
  } catch (err) {
    Toast.error('Failed to load settings');
  }
}

// ---- Automated follow-up sequence settings ----
function renderFollowUpConfig(cfg) {
  const enabledEl = document.getElementById('followup-enabled');
  const stepsEl   = document.getElementById('followup-steps');
  if (!enabledEl || !stepsEl) return;
  enabledEl.checked = !!cfg.enabled;

  const drawSteps = (steps) => {
    stepsEl.innerHTML = steps.map((s, i) => `
      <div style="display:flex;align-items:center;gap:8px" data-step="${i}">
        <span style="font-size:0.82rem;color:var(--text-muted);min-width:78px">Follow-up ${i + 1}</span>
        <input type="number" class="fu-days" min="1" max="90" value="${s.days}" style="width:70px;padding:4px 6px;font-size:0.85rem" />
        <span style="font-size:0.82rem;color:var(--text-muted)">days after previous</span>
        <button type="button" class="btn btn-ghost btn-xs fu-remove" data-i="${i}" style="color:#ef4444">Remove</button>
      </div>
    `).join('');
    stepsEl.querySelectorAll('.fu-remove').forEach(b => b.addEventListener('click', () => {
      const cur = collectFollowUpSteps();
      cur.splice(parseInt(b.dataset.i, 10), 1);
      drawSteps(cur.length ? cur : [{ days: 3 }]);
    }));
  };
  drawSteps(cfg.steps && cfg.steps.length ? cfg.steps : [{ days: 3 }, { days: 7 }]);

  const addBtn = document.getElementById('followup-add-step');
  if (addBtn && !addBtn._wired) {
    addBtn._wired = true;
    addBtn.addEventListener('click', () => {
      const cur = collectFollowUpSteps();
      if (cur.length >= 5) { Toast.warning('Maximum 5 follow-ups'); return; }
      const last = cur.length ? cur[cur.length - 1].days : 3;
      cur.push({ days: last + 4 });
      drawSteps(cur);
    });
  }
  const saveBtn = document.getElementById('followup-save');
  if (saveBtn && !saveBtn._wired) {
    saveBtn._wired = true;
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      try {
        await API.settings.update({
          followUpConfig: {
            enabled: document.getElementById('followup-enabled').checked,
            steps: collectFollowUpSteps()
          }
        });
        Toast.success('Follow-up settings saved');
      } catch (err) { Toast.error(err.message); }
      finally { saveBtn.disabled = false; saveBtn.textContent = 'Save Follow-Up Settings'; }
    });
  }
}

function collectFollowUpSteps() {
  return [...document.querySelectorAll('#followup-steps .fu-days')]
    .map(inp => ({ days: parseInt(inp.value, 10) }))
    .filter(s => Number.isFinite(s.days) && s.days >= 1 && s.days <= 90);
}

// ---- Outreach style sample ----
function renderOutreachSample(sample, subjectSample) {
  const ta  = document.getElementById('outreach-sample');
  const sub = document.getElementById('subject-sample');
  if (!ta) return;
  ta.value  = sample || '';
  if (sub) sub.value = subjectSample || '';

  const saveBtn = document.getElementById('outreach-sample-save');
  if (saveBtn && !saveBtn._wired) {
    saveBtn._wired = true;
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      try {
        const payload = { outreachSample: ta.value };
        if (sub) payload.subjectSample = sub.value.trim().slice(0, 200);
        await API.settings.update(payload);
        Toast.success(ta.value.trim().length > 40 ? 'Style saved — outreach will now match your sample' : 'Saved');
      } catch (err) { Toast.error(err.message); }
      finally { saveBtn.disabled = false; saveBtn.textContent = 'Save Style Sample'; }
    });
  }

  const clearBtn = document.getElementById('outreach-sample-clear');
  if (clearBtn && !clearBtn._wired) {
    clearBtn._wired = true;
    clearBtn.addEventListener('click', async () => {
      ta.value = '';
      if (sub) sub.value = '';
      try {
        await API.settings.update({ outreachSample: '', subjectSample: '' });
        Toast.show('Style sample cleared — using the built-in approach');
      } catch (err) { Toast.error(err.message); }
    });
  }
}

// ---- Daily auto-outreach (autopilot) settings ----
function renderAutopilotConfig(cfg) {
  const $ = id => document.getElementById(id);
  if (!$('ap-enabled')) return;
  $('ap-enabled').checked      = !!cfg.enabled;
  $('ap-daily-cap').value      = cfg.dailyCap      ?? 30;
  $('ap-min-spacing').value    = cfg.minSpacingMin ?? 20;
  $('ap-max-spacing').value    = cfg.maxSpacingMin ?? 60;
  $('ap-window-start').value   = cfg.windowStart   || '09:00';
  $('ap-window-end').value     = cfg.windowEnd     || '17:00';
  $('ap-weekdays').checked     = cfg.weekdaysOnly !== false;
  $('ap-warmup').checked       = cfg.warmup !== false;

  refreshAutopilotStatus();

  const saveBtn = $('ap-save');
  if (saveBtn && !saveBtn._wired) {
    saveBtn._wired = true;
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      try {
        const min = parseInt($('ap-min-spacing').value, 10) || 20;
        let max = parseInt($('ap-max-spacing').value, 10) || 60;
        if (max < min) max = min;
        await API.settings.update({
          tzOffset: -new Date().getTimezoneOffset() / 60,  // real browser timezone
          autopilot: {
            enabled:       $('ap-enabled').checked,
            dailyCap:      parseInt($('ap-daily-cap').value, 10) || 30,
            minSpacingMin: min,
            maxSpacingMin: max,
            windowStart:   $('ap-window-start').value || '09:00',
            windowEnd:     $('ap-window-end').value   || '17:00',
            weekdaysOnly:  $('ap-weekdays').checked,
            warmup:        $('ap-warmup').checked
          }
        });
        Toast.success($('ap-enabled').checked ? 'Auto-outreach is on' : 'Auto-outreach settings saved');
        refreshAutopilotStatus();
      } catch (err) { Toast.error(err.message); }
      finally { saveBtn.disabled = false; saveBtn.textContent = 'Save Auto-Outreach Settings'; }
    });
  }

  // "Send batch now" — force a run regardless of window, for testing/control
  const runBtn = $('ap-run-now');
  if (runBtn && !runBtn._wired) {
    runBtn._wired = true;
    runBtn.addEventListener('click', async () => {
      const result = $('ap-run-result');
      runBtn.disabled = true; runBtn.textContent = 'Running…';
      try {
        const r = await API.settings.autopilotRunNow();
        if (result) {
          result.style.display = 'block';
          if (r.queued > 0) {
            result.style.color = '#16a34a';
            result.textContent = `✓ ${r.message}`;
          } else {
            result.style.color = '#b45309';
            result.textContent = `⚠️ ${r.message || 'Nothing was queued.'}`;
          }
        }
        if (r.queued > 0) Toast.success(`Queued ${r.queued} email${r.queued !== 1 ? 's' : ''}`);
        refreshAutopilotStatus();
      } catch (err) {
        if (result) { result.style.display = 'block'; result.style.color = '#dc2626'; result.textContent = '✗ ' + err.message; }
        Toast.error(err.message);
      } finally { runBtn.disabled = false; runBtn.textContent = '▶ Send batch now'; }
    });
  }
}

// Email reconnect banner — appears when the email token has expired so users
// notice immediately instead of finding out only when a send fails.
function initReauthBanner() {
  const banner = document.getElementById('reauth-banner');
  if (!banner) return;
  if (!currentUser || !currentUser.emailNeedsReauth) { banner.style.display = 'none'; return; }
  banner.style.display = 'flex';

  const reconnect = document.getElementById('reauth-reconnect-btn');
  if (reconnect && !reconnect._wired) {
    reconnect._wired = true;
    reconnect.addEventListener('click', async () => {
      reconnect.disabled = true; reconnect.textContent = 'Opening…';
      try {
        const { url } = await API.email.getConnectUrl();
        window.location.href = url;
      } catch (err) { Toast.error(err.message); reconnect.disabled = false; reconnect.textContent = 'Reconnect now'; }
    });
  }
  const dismiss = document.getElementById('reauth-dismiss-btn');
  if (dismiss && !dismiss._wired) {
    dismiss._wired = true;
    dismiss.addEventListener('click', () => { banner.style.display = 'none'; });
  }
}

// Live local clock — uses the browser's own timezone, so it's always the user's
// real local time. Ticks every second; shows time + abbreviated zone.
function startSidebarClock() {
  const timeEl = document.getElementById('sidebar-clock-time');
  if (!timeEl) return;
  let tz = '';
  try {
    const parts = new Intl.DateTimeFormat([], { timeZoneName: 'short' }).formatToParts(new Date());
    tz = (parts.find(p => p.type === 'timeZoneName') || {}).value || '';
  } catch {}
  const tick = () => {
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    timeEl.textContent = tz ? `${t} ${tz}` : t;
  };
  tick();
  setInterval(tick, 1000);
}

async function refreshAutopilotStatus() {
  const box = document.getElementById('ap-status');
  if (!box) return;
  try {
    const s = await API.settings.autopilotStatus();
    if (!s.enabled) { box.style.display = 'none'; return; }
    box.style.display = 'block';

    // Blocked — something is stopping sends. Show an amber warning with the reason.
    if (s.blocker) {
      box.style.background = '#fef3c7';
      box.style.border = '1px solid #fcd34d';
      box.style.color = '#92400e';
      box.innerHTML = `<strong>⚠️ Not sending.</strong> ${escapeHtml(s.statusMessage || '')}`;
      return;
    }

    // Healthy — reset to the blue "active" styling
    box.style.background = '#eef2ff';
    box.style.border = '1px solid #c7d2fe';
    box.style.color = '#3730a3';
    const next = s.nextAt ? new Date(s.nextAt).toLocaleString([], { weekday:'short', hour:'2-digit', minute:'2-digit' }) : '—';
    const failNote = s.failedToday ? `<br><span style="color:#b45309">${s.failedToday} failed today${s.lastError ? ' — ' + escapeHtml(s.lastError) : ''}</span>` : '';
    box.innerHTML = `
      <strong>Active.</strong> Sent <strong>${s.sentToday}</strong> today ·
      ${s.pendingToday} queued · next at <strong>${next}</strong><br>
      Today's limit: ${s.todaysCap}${s.warmup && s.todaysCap < s.dailyCap ? ` <span style="opacity:.7">(warming up → ${s.dailyCap})</span>` : ''} ·
      <strong>${s.eligibleRemaining}</strong> candidates remaining in pipeline
      ${s.nextAt ? '' : `<br><span style="opacity:.8">${escapeHtml(s.statusMessage || '')}</span>`}
      ${failNote}`;
  } catch { box.style.display = 'none'; }
}

async function updateGmailStatus() {
  try {
    const status = await API.settings.gmailStatus();
    const el = document.getElementById('gmail-status-indicator');
    const connectBtn = document.getElementById('connect-gmail-btn');
    const disconnectBtn = document.getElementById('disconnect-gmail-btn');
    const testBtn = document.getElementById('test-email-btn');

    if (status.connected) {
      el.className = 'gmail-status connected';
      el.innerHTML = `<span class="status-dot"></span> Connected as ${status.address}`;
      connectBtn.classList.add('hidden');
      disconnectBtn.classList.remove('hidden');
      testBtn.classList.remove('hidden');
    } else {
      el.className = 'gmail-status disconnected';
      el.innerHTML = `<span class="status-dot"></span> Not connected`;
      connectBtn.classList.remove('hidden');
      disconnectBtn.classList.add('hidden');
      testBtn.classList.add('hidden');
    }
  } catch { /* ignore */ }
}

async function updateZohoStatus() {
  try {
    const status = await API.settings.zohoStatus();
    const dot  = document.getElementById('zoho-status-dot');
    const text = document.getElementById('zoho-status-text');
    const form = document.getElementById('zoho-connect-form');
    const acts = document.getElementById('zoho-connected-actions');

    if (status.connected) {
      dot.style.background  = '#22c55e';
      text.textContent = `Connected as ${status.address}`;
      form.style.display = 'none';
      acts.style.display = 'flex';
    } else {
      dot.style.background  = 'var(--text-faint)';
      text.textContent = 'Not connected';
      form.style.display = 'block';
      acts.style.display = 'none';
    }
  } catch { /* ignore */ }
}

async function updateOutlookStatus() {
  try {
    const status = await API.settings.outlookStatus();
    const dot  = document.getElementById('outlook-status-dot');
    const text = document.getElementById('outlook-status-text');
    const form = document.getElementById('outlook-connect-form');
    const acts = document.getElementById('outlook-connected-actions');
    if (!dot) return;

    if (status.connected) {
      dot.style.background = '#22c55e';
      text.textContent = `Connected as ${status.address}`;
      form.style.display = 'none';
      acts.style.display = 'flex';
    } else {
      dot.style.background = 'var(--text-faint)';
      text.textContent = 'Not connected';
      form.style.display = 'block';
      acts.style.display = 'none';
    }
  } catch { /* ignore */ }
}
