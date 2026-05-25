/* ============================================================
   Recruit Pro — Background service worker (Manifest V3)
   Receives IMPORT_PROFILE messages from the content script,
   POSTs directly to /api/linkedin/quick-import using a per-user
   extension token. No new tab is opened — the user stays on LinkedIn.
   ============================================================ */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'IMPORT_PROFILE') return false;
  handleImport(msg).then(sendResponse).catch(err => sendResponse({ error: err.message }));
  return true; // keep channel open for async response
});

async function handleImport ({ url, text, coEmails }) {
  const { appUrl, apiToken } = await chrome.storage.sync.get(['appUrl', 'apiToken']);

  if (!appUrl) return { error: 'App URL not set — click the 🎯 icon to configure.' };
  if (!apiToken) return { error: 'Extension token not set — click the 🎯 icon and paste your token from Settings.' };

  const base = appUrl.replace(/\/+$/, '');

  try {
    const res = await fetch(`${base}/api/linkedin/quick-import`, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'X-Extension-Token': apiToken
      },
      body: JSON.stringify({ url, text, coEmails: coEmails || [] })
    });

    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      return { error: `Wrong app URL — got HTML back. Click 🎯 and check your URL.` };
    }

    const data = await res.json();

    if (res.status === 409) return { error: data.error || 'Already in pipeline.' };
    if (!res.ok)            return { error: data.error || `Server error ${res.status}` };

    // Success — no new tab, user stays on LinkedIn
    return { success: true, name: data.name, company: data.company, email: data.email };

  } catch (err) {
    return { error: `Request failed: ${err.message}` };
  }
}
