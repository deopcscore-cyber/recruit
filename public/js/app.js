/* ============================================================
   Welltower Recruiter — Main Application
   ============================================================ */

let currentUser = null;
let allCandidates = [];
let currentView = 'pipeline';
let currentFilter = { stage: '', search: '' };

// ---- Boot ----
document.addEventListener('DOMContentLoaded', async () => {
  // Dark mode
  applyTheme(localStorage.getItem('theme') || 'light');

  try {
    currentUser = await API.auth.me();
    if (!currentUser) { window.location.href = '/'; return; }
  } catch {
    window.location.href = '/';
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
  }

  document.getElementById('sidebar-user-name').textContent = currentUser.name;
  document.getElementById('sidebar-user-email').textContent = currentUser.email;

  // Nav
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      navigateTo(item.dataset.page);
      if (item.dataset.page === 'analytics') loadAnalyticsPage();
      if (item.dataset.page === 'followups') loadFollowUpPage();
    });
  });

  // Logout
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await API.auth.logout();
    window.location.href = '/';
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

  // Analytics refresh button
  document.getElementById('refresh-analytics-btn').addEventListener('click', loadAnalyticsPage);

  // Follow-up filter option (injected dynamically)
  const stageFilter = document.getElementById('stage-filter');
  const fuOpt = document.createElement('option');
  fuOpt.value = '__followup__'; fuOpt.textContent = '⏰ Follow-Up Due';
  stageFilter.appendChild(fuOpt);

  // Load candidates
  await loadCandidates();
  navigateTo('candidates');

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
  if (page === 'settings')  loadSettingsPage();
  if (page === 'followups') loadFollowUpPage();
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
    updateUnreadBadge();
    updateFollowUpBadge();
  } catch (err) {
    Toast.error('Failed to load candidates: ' + err.message);
  }
}

function getFilteredCandidates() {
  let filtered = [...allCandidates];
  if (currentFilter.stage === '__followup__') {
    const now = new Date();
    filtered = filtered.filter(c => c.followUpDate && new Date(c.followUpDate) <= now && c.stage !== 'Closed');
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
  return filtered;
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
  const count = allCandidates.filter(c =>
    c.followUpDate && new Date(c.followUpDate) <= now && c.stage !== 'Closed'
  ).length;
  const badge = document.getElementById('followup-badge');
  if (badge) {
    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
    badge.style.background = count > 0 ? '#f97316' : '';
  }
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
    } else {
      Toast.show('No new replies found');
    }
  } catch (err) {
    Toast.error('Failed to fetch emails: ' + err.message);
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
  new Modal('bulk-outreach-modal').open();

  // If there's already an active server queue, show its status
  refreshQueueStatus();
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

  const now = new Date();
  let cum = 0;
  listEl.innerHTML = checked.map((cb, i) => {
    cum += window._bulkDelays[i];
    const t = new Date(now.getTime() + cum).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const gap = i === 0 ? '<span style="color:#10b981;font-weight:600">Now</span>' : `<span style="color:#94a3b8">+${fmtMins(window._bulkDelays[i])}</span>`;
    return `<div style="display:flex;align-items:center;gap:10px;padding:3px 0">
      <span style="min-width:72px;color:#475569;font-size:0.82rem">${t}</span>
      <span style="min-width:56px;font-size:0.78rem">${gap}</span>
      <span style="font-weight:500">${escapeHtml(cb.dataset.name)}</span>
    </div>`;
  }).join('');

  const totalMins = Math.round(cum / 60000);
  totalEl.textContent = `${checked.length} email${checked.length !== 1 ? 's' : ''} over ~${totalMins} min — runs on the server, safe to close this window`;
  preview.style.display = 'block';
}

async function handleBulkOutreach() {
  const checked = [...document.querySelectorAll('.bulk-cb:checked')];
  if (checked.length === 0) { Toast.warning('Select at least one candidate'); return; }

  const delays     = window._bulkDelays || checked.map((_, i) => i === 0 ? 0 : randDelayMs());
  const subjectTpl = document.getElementById('bulk-subject').value.trim();
  const startBtn   = document.getElementById('bulk-outreach-start-btn');
  const progressEl = document.getElementById('bulk-progress');

  // Build job list with absolute scheduled times
  const now  = Date.now();
  let cumMs  = 0;
  const jobs = checked.map((cb, i) => {
    cumMs += delays[i];
    const candidate = allCandidates.find(c => c.id === cb.dataset.id);
    const firstName = (cb.dataset.name || '').split(' ')[0];
    const subject   = subjectTpl || `Something Worth a Few Minutes of Your Time, ${firstName}`;
    return {
      candidateId:   cb.dataset.id,
      candidateName: cb.dataset.name,
      subject,
      scheduledAt:   new Date(now + cumMs).toISOString()
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
  const due = allCandidates
    .filter(c => c.followUpDate && new Date(c.followUpDate) <= now && c.stage !== 'Closed')
    .sort((a, b) => new Date(a.followUpDate) - new Date(b.followUpDate)); // most overdue first

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
    const daysOver = Math.floor((now - new Date(c.followUpDate)) / 86400000);
    const overdueLabel = daysOver === 0 ? 'Due today' : `${daysOver}d overdue`;
    const overdueColor = daysOver === 0 ? '#d97706' : '#ef4444';
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
    Toast.error('Failed to send: ' + err.message);
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

    el.innerHTML = `
      <!-- KPI strip -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:16px;margin-bottom:24px">
        ${[
          { label:'Total Candidates', value: d.total, color:'#2563eb' },
          { label:'Response Rate',    value: d.responseRate+'%', color:'#7c3aed' },
          { label:'Email Open Rate',  value: d.openRate+'%', color:'#0891b2' },
          { label:'Avg Days Active',  value: d.avgDays+'d', color:'#d97706' },
          { label:'Unread Replies',   value: d.unreadCount, color: d.unreadCount>0?'#ef4444':'#16a34a' },
          { label:'Follow-Ups Due',   value: d.followUpsDue, color: d.followUpsDue>0?'#f97316':'#16a34a' }
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

      <!-- Follow-ups due -->
      <div class="settings-card">
        <div class="settings-card-header">
          <h3>⏰ Follow-Ups Due <span style="font-size:0.8rem;font-weight:400;color:var(--text-muted)">(${d.followUpsDue})</span></h3>
        </div>
        <div class="settings-card-body">${followUpHtml}</div>
      </div>
    `;
  } catch (err) {
    el.innerHTML = `<div style="padding:40px;text-align:center;color:#ef4444">Failed to load analytics: ${err.message}</div>`;
  }
}

// ---- Settings ----
function initSettingsPage() {
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

  document.getElementById('profile-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const data = {
        name: document.getElementById('profile-name').value.trim(),
        title: document.getElementById('profile-title').value.trim()
      };
      await API.settings.update(data);
      if (currentUser) {
        if (data.name) currentUser.name = data.name;
        currentUser.title = data.title;
      }
      Toast.success('Profile saved');
    } catch (err) { Toast.error(err.message); }
    finally { btn.disabled = false; btn.textContent = 'Save Profile'; }
  });

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

  document.getElementById('sig-preview-btn').addEventListener('click', () => {
    const box     = document.getElementById('sig-preview-box');
    const content = document.getElementById('sig-preview-content');
    const name    = document.getElementById('profile-name').value.trim()  || (currentUser && currentUser.name) || 'Your Name';
    const title   = document.getElementById('profile-title').value.trim() || 'Senior Talent Acquisition Coordinator';
    const photo   = document.getElementById('sig-photo').value.trim();
    const website = document.getElementById('sig-website').value.trim();
    const loc     = document.getElementById('sig-location').value.trim();
    const linkedin= document.getElementById('sig-linkedin').value.trim();
    const facebook= document.getElementById('sig-facebook').value.trim();
    const twitter = document.getElementById('sig-twitter').value.trim();
    const disc    = document.getElementById('sig-disclaimer').value.trim();

    const photoHtml = photo
      ? `<img src="${photo}" width="72" height="72" style="border-radius:50%;object-fit:cover;display:block;border:3px solid #1a3e72;box-shadow:0 2px 10px rgba(26,62,114,.18)" />`
      : '';

    const contactParts = [];
    if (website) contactParts.push(`<a href="${website}" style="color:#1a3e72;text-decoration:none;font-size:12px">🌐 ${website.replace(/^https?:\/\//, '')}</a>`);
    if (loc)     contactParts.push(`<span style="color:#64748b;font-size:12px">📍 ${loc}</span>`);
    const contactLine = contactParts.length ? `<p style="margin:5px 0 0">${contactParts.join(' &nbsp;|&nbsp; ')}</p>` : '';

    const iconBadge = (href, bg, letter) => href
      ? `<a href="${href}" target="_blank" style="display:inline-block;background:${bg};color:#fff;width:28px;height:28px;line-height:28px;text-align:center;border-radius:6px;font-weight:800;font-size:13px;text-decoration:none;margin-right:6px">${letter}</a>`
      : '';

    const socialHtml = (linkedin || facebook || twitter)
      ? `<div style="margin-top:12px">${iconBadge(linkedin,'#0077B5','in')}${iconBadge(facebook,'#1877F2','f')}${iconBadge(twitter,'#111','𝕏')}</div>`
      : '';

    const ctaHtml = website
      ? `<a href="${website}" target="_blank" style="display:inline-block;background:#1a3e72;color:#fff;font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;padding:7px 15px;border-radius:5px;text-decoration:none;margin-left:10px">Visit Website →</a>`
      : '';

    const actionsHtml = (linkedin || facebook || twitter || website)
      ? `<div style="margin-top:12px;display:flex;align-items:center">${(linkedin||facebook||twitter)?`<span>${iconBadge(linkedin,'#0077B5','in')}${iconBadge(facebook,'#1877F2','f')}${iconBadge(twitter,'#111','𝕏')}</span>`:''} ${ctaHtml}</div>`
      : '';

    const discHtml = disc
      ? `<div style="margin-top:14px;padding-top:10px;border-top:1px solid #e8edf4"><p style="margin:0;font-size:9.5px;color:#94a3b8;line-height:1.55">${disc}</p></div>`
      : '';

    content.innerHTML = `
      <div style="max-width:540px">
        <div style="height:3px;background:linear-gradient(90deg,#1a3e72 0%,#3b6dc7 60%,rgba(59,109,199,0) 100%);margin-bottom:20px;border-radius:2px"></div>
        <p style="margin:0 0 18px;font-size:16px;font-family:Georgia,serif;color:#2d2d2d;font-style:italic">Sincerely,</p>
        <div style="display:flex;align-items:flex-start">
          ${photo ? `<div style="flex-shrink:0;margin-right:18px">${photoHtml}</div>` : ''}
          <div style="border-left:3px solid #1a3e72;padding-left:14px;line-height:1.4">
            <p style="margin:0;font-size:16px;font-weight:700;color:#0f172a;letter-spacing:-.2px">${name}</p>
            <p style="margin:3px 0 0;font-size:12px;color:#475569">${title}</p>
            <p style="margin:3px 0 0;font-size:12px;font-weight:600;color:#1a3e72">Welltower Inc. &nbsp;<span style="color:#94a3b8;font-weight:400">|</span>&nbsp; <span style="color:#64748b;font-weight:500">NYSE: WELL</span></p>
            ${contactLine}
          </div>
        </div>
        ${actionsHtml}
        ${discHtml}
      </div>`;
    box.style.display = 'block';
  });
}

async function loadSettingsPage() {
  try {
    const style = await API.settings.get();
    document.getElementById('profile-name').value = style.name || (currentUser && currentUser.name) || '';
    document.getElementById('profile-title').value = style.title || (currentUser && currentUser.title) || '';
    document.getElementById('style-tone').value = style.tone || 'warm';
    document.getElementById('style-notes').value = style.notes || '';
    document.getElementById('style-use').value = (style.use || []).join(', ');
    document.getElementById('style-avoid').value = (style.avoid || []).join(', ');

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

    await updateGmailStatus();
  } catch (err) {
    Toast.error('Failed to load settings');
  }
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
