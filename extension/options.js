/* ============================================================
   Recruit Pro — Options / Popup script
   ============================================================ */

const urlInput   = document.getElementById('appUrl');
const tokenInput = document.getElementById('apiToken');
const saveBtn    = document.getElementById('saveBtn');
const statusEl   = document.getElementById('status');
const openLink   = document.getElementById('openDashboard');

// Load saved values on open
chrome.storage.sync.get(['appUrl', 'apiToken'], ({ appUrl, apiToken }) => {
  if (appUrl) { urlInput.value = appUrl; openLink.href = appUrl; }
  if (apiToken) tokenInput.value = apiToken;

  // If no URL yet, pre-fill placeholder from the active tab
  if (!appUrl) {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs && tabs[0];
      if (tab && tab.url && !tab.url.includes('linkedin.com')) {
        try { urlInput.placeholder = new URL(tab.url).origin; } catch (_) {}
      }
    });
  }
});

saveBtn.addEventListener('click', () => {
  let raw   = urlInput.value.trim();
  const tok = tokenInput.value.trim();

  if (!raw) { show('Please enter your app URL', 'err'); return; }
  if (!tok) { show('Please paste your extension token', 'err'); return; }

  // Auto-prefix https:// if missing
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;

  // Always store just the origin (strip /dashboard or any other path)
  let url = raw;
  try { url = new URL(raw).origin; } catch (_) {}

  chrome.storage.sync.set({ appUrl: url, apiToken: tok }, () => {
    urlInput.value = url;
    openLink.href  = url;
    show('✓ Saved!', 'ok');
    setTimeout(() => show('', ''), 3000);
  });
});

[urlInput, tokenInput].forEach(el => {
  el.addEventListener('keydown', e => { if (e.key === 'Enter') saveBtn.click(); });
});

function show (msg, cls) {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + (cls || '');
}
