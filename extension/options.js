/* ============================================================
   Recruit Pro — Options / Popup script
   ============================================================ */

const urlInput   = document.getElementById('appUrl');
const saveBtn    = document.getElementById('saveBtn');
const statusEl   = document.getElementById('status');
const openLink   = document.getElementById('openDashboard');

// Load saved URL on open; if none saved yet, try to infer from the tab that opened this popup
chrome.storage.sync.get('appUrl', ({ appUrl }) => {
  if (appUrl) {
    urlInput.value = appUrl;
    openLink.href = appUrl;
  } else {
    // Pre-fill hint using the active tab's origin if it looks like our app
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs && tabs[0];
      if (tab && tab.url && !tab.url.includes('linkedin.com')) {
        try {
          const origin = new URL(tab.url).origin;
          urlInput.placeholder = origin;
        } catch (_) {}
      }
    });
  }
});

saveBtn.addEventListener('click', () => {
  let raw = urlInput.value.trim();

  if (!raw) {
    show('Please enter your app URL', 'err');
    return;
  }

  // Auto-prefix https:// if missing
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;

  // Always store just the origin (strip /dashboard or any other path)
  let url = raw;
  try { url = new URL(raw).origin; } catch (_) {}

  chrome.storage.sync.set({ appUrl: url }, () => {
    urlInput.value = url;
    openLink.href = url;
    show('✓ Saved! (' + url + ')', 'ok');
    setTimeout(() => show('', ''), 4000);
  });
});

urlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') saveBtn.click();
});

function show (msg, cls) {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + (cls || '');
}
