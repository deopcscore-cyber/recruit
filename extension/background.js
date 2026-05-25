/* ============================================================
   Recruit Pro — Background service worker (Manifest V3)
   Receives IMPORT_PROFILE messages from the content script,
   POSTs to the Recruit Pro API, then opens the dashboard.
   ============================================================ */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'IMPORT_PROFILE') return false;

  // Run async and keep channel open with `return true`
  handleImport(msg).then(sendResponse).catch(err => sendResponse({ error: err.message }));
  return true;
});

async function handleImport ({ url, text, coEmails }) {
  // Get the configured app URL
  const { appUrl } = await chrome.storage.sync.get('appUrl');

  if (!appUrl) {
    return { error: 'App URL not set — click the extension icon to configure it.' };
  }

  const base = appUrl.replace(/\/+$/, '');

  let data;
  try {
    const res = await fetch(`${base}/api/linkedin/bookmarklet`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url, text, coEmails: coEmails || [] })
    });
    data = await res.json();
    if (!res.ok) return { error: data.error || `Server error ${res.status}` };
  } catch (err) {
    return { error: `Network error: ${err.message}` };
  }

  if (data.error) return { error: data.error };

  // Open the dashboard with the import token in a new tab
  await chrome.tabs.create({ url: `${base}/dashboard?li=${data.token}` });
  return { success: true };
}
