/* ============================================================
   Recruit Pro — Background service worker (Manifest V3)
   Handles two message types:
   • IMPORT_PROFILE          — single LinkedIn profile import
   • IMPORT_CONTACTOUT_BULK  — bulk import from ContactOut search results
   ============================================================ */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'IMPORT_PROFILE') {
    handleLinkedInImport(msg).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'IMPORT_CONTACTOUT_BULK') {
    handleContactOutBulk(msg).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  return false;
});

async function getConfig() {
  const { appUrl, apiToken } = await chrome.storage.sync.get(['appUrl', 'apiToken']);
  if (!appUrl)    return { error: 'App URL not set — click the 🎯 icon to configure.' };
  if (!apiToken)  return { error: 'Extension token not set — click the 🎯 icon and paste your token from Settings.' };
  return { base: appUrl.replace(/\/+$/, ''), apiToken };
}

// ── Single LinkedIn profile import ────────────────────────────────────────────
async function handleLinkedInImport({ url, text, coEmails }) {
  const cfg = await getConfig();
  if (cfg.error) return cfg;

  try {
    const res = await fetch(`${cfg.base}/api/linkedin/quick-import`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Extension-Token': cfg.apiToken },
      body:    JSON.stringify({ url, text, coEmails: coEmails || [] })
    });

    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      return { error: 'Wrong app URL — got HTML back. Click 🎯 and check your URL.' };
    }

    const data = await res.json();
    if (res.status === 409) return { error: data.error || 'Already in pipeline.' };
    if (!res.ok)            return { error: data.error || `Server error ${res.status}` };

    return { success: true, name: data.name, company: data.company, email: data.email };
  } catch (err) {
    return { error: `Request failed: ${err.message}` };
  }
}

// ── Bulk ContactOut import ─────────────────────────────────────────────────────
async function handleContactOutBulk({ candidates }) {
  const cfg = await getConfig();
  if (cfg.error) return cfg;

  if (!candidates || candidates.length === 0) {
    return { error: 'No candidates to import.' };
  }

  try {
    const res = await fetch(`${cfg.base}/api/contactout/bulk-import`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Extension-Token': cfg.apiToken },
      body:    JSON.stringify({ candidates })
    });

    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      return { error: 'Wrong app URL — got HTML back. Click 🎯 and check your URL.' };
    }

    const data = await res.json();
    if (!res.ok) return { error: data.error || `Server error ${res.status}` };

    return { success: true, added: data.added, skipped: data.skipped, failed: data.failed };
  } catch (err) {
    return { error: `Request failed: ${err.message}` };
  }
}
