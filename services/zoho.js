/* ============================================================
   Welltower Recruiter — Zoho Mail Service (OAuth2 REST API)
   SMTP is blocked on Railway — Zoho's HTTPS API is used instead.
   ============================================================ */

const axios   = require('axios');
const { v4: uuidv4 } = require('uuid');
const storage = require('./storage');
const { BASE_URL, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET } = require('../config');
const { buildRawEmailParts, buildSignatureHtml, buildSignaturePlainText } = require('./gmail');

const TOKEN_URL      = 'https://accounts.zoho.com/oauth/v2/token';
const API_BASE_DEFAULT = 'https://mail.zoho.com/api';

// Zoho's api_domain from the token response tells us the user's data center.
// Map e.g. "https://www.zohoapis.eu" → "https://mail.zoho.eu/api"
function apiBaseFromDomain(apiDomain) {
  if (!apiDomain) return API_BASE_DEFAULT;
  const match = apiDomain.match(/zohoapis\.(.+)$/);
  if (!match) return API_BASE_DEFAULT;
  return `https://mail.zoho.${match[1]}/api`;
}

function userApiBase(user) {
  return (user.zoho && user.zoho.apiBase) || API_BASE_DEFAULT;
}

// When a user connected before apiBase was tracked, detect the right data center
// by trying each region until one responds successfully.
const ZOHO_API_BASES = [
  'https://mail.zoho.com/api',
  'https://mail.zoho.eu/api',
  'https://mail.zoho.in/api',
  'https://mail.zoho.com.au/api',
  'https://mail.zoho.jp/api',
];

async function detectAndSaveApiBase(user, token) {
  // The most reliable source of the correct region is Zoho's token refresh response,
  // which always includes api_domain for the user's data center.
  if (user.zoho.refreshToken) {
    try {
      const params = new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     ZOHO_CLIENT_ID,
        client_secret: ZOHO_CLIENT_SECRET,
        refresh_token: user.zoho.refreshToken
      });
      const { data } = await axios.post(TOKEN_URL, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      if (data.access_token && data.api_domain) {
        const newBase = apiBaseFromDomain(data.api_domain);
        user.zoho.accessToken  = data.access_token;
        user.zoho.expiresAt    = Date.now() + (data.expires_in || 3600) * 1000;
        user.zoho.apiBase      = newBase;
        await storage.saveUser(user);
        console.log(`Zoho: region corrected via token refresh → ${newBase} for user ${user.id}`);
        return newBase;
      }
    } catch (e) {
      console.error('Zoho: token refresh for region detection failed:', e.message);
    }
  }

  // Fallback: probe all regions with the messages-specific path (strictly region-routed)
  const { accountId } = user.zoho;
  console.log(`Zoho: probing regions by messages endpoint for accountId=${accountId}`);
  for (const base of ZOHO_API_BASES) {
    try {
      // Deliberately probe a path that's strictly region-routed (not /folders which is global)
      await axios.get(`${base}/accounts/${accountId}/messages/search`, {
        params: { searchKey: '_detectregion_', limit: 1 },
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        timeout: 8000
      });
      user.zoho.apiBase = base;
      await storage.saveUser(user);
      console.log(`Zoho: detected apiBase=${base} for user ${user.id}`);
      return base;
    } catch (e) {
      const status = e.response?.status;
      const code   = e.response?.data?.data?.errorCode;
      console.log(`Zoho: region ${base} → status=${status} code=${code}`);
      // Accept this region if it returned anything OTHER than URL_RULE_NOT_CONFIGURED
      if (status && !(code === 'URL_RULE_NOT_CONFIGURED')) {
        user.zoho.apiBase = base;
        await storage.saveUser(user);
        console.log(`Zoho: accepted region ${base} (non-routing error) for user ${user.id}`);
        return base;
      }
    }
  }
  console.error(`Zoho: no working region found for user ${user.id}, accountId=${accountId}`);
  return API_BASE_DEFAULT;
}

// ── OAuth2 helpers ────────────────────────────────────────────────────────────
// `state` is an opaque CSRF nonce verified against the session on callback —
// never a user ID (that allowed account takeover).
function getAuthUrl(state) {
  if (!ZOHO_CLIENT_ID) throw new Error('ZOHO_CLIENT_ID not configured');
  const params = new URLSearchParams({
    scope:         'ZohoMail.messages.CREATE,ZohoMail.accounts.READ,ZohoMail.messages.READ,ZohoMail.messages.UPDATE,ZohoMail.folders.READ',
    client_id:     ZOHO_CLIENT_ID,
    response_type: 'code',
    access_type:   'offline',
    prompt:        'consent',
    redirect_uri:  `${BASE_URL}/auth/zoho/callback`,
    state
  });
  return `https://accounts.zoho.com/oauth/v2/auth?${params}`;
}

async function exchangeCode(userId, code) {
  const params = new URLSearchParams({
    grant_type:    'authorization_code',
    client_id:     ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    redirect_uri:  `${BASE_URL}/auth/zoho/callback`,
    code
  });
  const { data } = await axios.post(TOKEN_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  if (!data.access_token) throw new Error('No access token returned from Zoho');

  const user = await storage.getUserById(userId);
  if (!user) throw new Error('User not found');

  const apiBase = apiBaseFromDomain(data.api_domain);

  // Fetch the account ID, address, and display name
  const { accountId, address, displayName } = await fetchAccountInfo(data.access_token, apiBase);

  const existingRefreshToken = (user.zoho && user.zoho.refreshToken) || null;
  user.zoho = {
    connected:    true,
    address:      (address || '').toLowerCase(),
    displayName:  displayName || '',
    accountId,
    apiBase,
    accessToken:  data.access_token,
    refreshToken: data.refresh_token || existingRefreshToken,
    expiresAt:    Date.now() + (data.expires_in || 3600) * 1000
  };
  await storage.saveUser(user);
  return user.zoho;
}

async function refreshTokens(user) {
  const zoho = user.zoho;
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    refresh_token: zoho.refreshToken
  });
  const { data } = await axios.post(TOKEN_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  if (!data.access_token) throw new Error('Zoho token refresh failed');
  user.zoho.accessToken = data.access_token;
  user.zoho.expiresAt   = Date.now() + (data.expires_in || 3600) * 1000;
  // Zoho's token refresh response includes api_domain — use it to correct the region
  if (data.api_domain) {
    const refreshedBase = apiBaseFromDomain(data.api_domain);
    if (refreshedBase !== API_BASE_DEFAULT || !user.zoho.apiBase) {
      user.zoho.apiBase = refreshedBase;
    }
  }
  await storage.saveUser(user);
  return user.zoho.accessToken;
}

async function revokeTokens(user) {
  const token = user.zoho?.refreshToken || user.zoho?.accessToken;
  if (!token) return;
  await axios.post(`https://accounts.zoho.com/oauth/v2/token/revoke?token=${encodeURIComponent(token)}`, null, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
}

async function getAccessToken(user) {
  if (!user.zoho || !user.zoho.connected) throw new Error('Zoho not connected');
  // Token still valid — use it
  if (Date.now() < (user.zoho.expiresAt || 0) - 60000) return user.zoho.accessToken;
  // Token expired — need refresh token to get a new one
  if (!user.zoho.refreshToken) {
    throw new Error('Zoho session expired — please disconnect and reconnect Zoho in Settings > Email');
  }
  return refreshTokens(user);
}

async function fetchAccountInfo(accessToken, apiBase = API_BASE_DEFAULT) {
  const { data } = await axios.get(`${apiBase}/accounts`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }
  });
  const acct = data.data && data.data[0];
  if (!acct) throw new Error('No Zoho account found');

  // primaryEmailAddress and mailboxAddress are plain strings.
  // emailAddress is an array of alias objects — skip it as a direct source.
  const address = acct.primaryEmailAddress
    || acct.mailboxAddress
    || acct.mailId
    || (Array.isArray(acct.emailAddress)
        ? (acct.emailAddress.find(e => e.isPrimary)?.mailId || acct.emailAddress[0]?.mailId)
        : (typeof acct.emailAddress === 'string' ? acct.emailAddress : ''))
    || '';

  if (!address) {
    console.error('Zoho: could not find email in account object keys:', Object.keys(acct));
    throw new Error('Could not read email address from Zoho account');
  }

  const displayName = acct.displayName
    || [acct.firstName, acct.lastName].filter(Boolean).join(' ')
    || '';

  return { accountId: acct.accountId, address, displayName };
}

// ── Send email via Zoho REST API ──────────────────────────────────────────────
async function sendEmail(userId, { to, subject, body, inReplyTo, references, trackingId }) {
  const user = await storage.getUserById(userId);
  if (!user) throw new Error('User not found');

  const token = await getAccessToken(user);
  const { accountId, address } = user.zoho;

  const sigHtml  = buildSignatureHtml(user);
  const sigPlain = buildSignaturePlainText(user);
  const { htmlBody } = buildRawEmailParts({ body, signatureHtml: sigHtml, signaturePlain: sigPlain, trackingId, baseUrl: BASE_URL });

  const fromName = (user.zoho.displayName || user.name || '').trim();
  const fromAddr = fromName ? `${fromName} <${address}>` : address;

  const payload = {
    fromAddress: fromAddr,
    toAddress:   to,
    subject,
    content:     htmlBody,
    mailFormat:  'html'
  };
  if (inReplyTo) payload.inReplyTo = inReplyTo;

  let apiBase = userApiBase(user);
  let sendUrl = `${apiBase}/accounts/${accountId}/messages`;
  console.log('Zoho send →', sendUrl, '| from:', fromAddr, '| to:', to);
  let resp;
  try {
    resp = await axios.post(sendUrl, payload,
      { headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' } });
  } catch (err) {
    const errBody = err.response ? err.response.data : null;
    const isWrongRegion = errBody && (
      (errBody.data && errBody.data.errorCode === 'URL_RULE_NOT_CONFIGURED') ||
      (errBody.status && errBody.status.code === 404)
    );
    if (isWrongRegion) {
      apiBase = await detectAndSaveApiBase(user, token);
      sendUrl = `${apiBase}/accounts/${accountId}/messages`;
      resp = await axios.post(sendUrl, payload,
        { headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' } });
    } else {
      const detail = err.response && JSON.stringify(err.response.data);
      console.error('Zoho send error:', err.response?.status, detail);
      throw new Error(`Zoho send failed (${err.response?.status}): ${detail || err.message}`);
    }
  }

  const msgId = (resp.data.data && resp.data.data.messageId) || uuidv4();
  return { gmailMessageId: null, gmailThreadId: null, smtpMessageId: String(msgId) };
}

// ── Fetch unread replies via Zoho REST API ────────────────────────────────────
async function fetchUnreadReplies(userId) {
  const user = await storage.getUserById(userId);
  if (!user) throw new Error('User not found');

  const token = await getAccessToken(user);
  const { accountId, address } = user.zoho;
  const apiBase = userApiBase(user);

  // Fetch INBOX folder ID — with region auto-detect fallback
  let effectiveBase = apiBase;
  let foldersRes;
  try {
    foldersRes = await axios.get(`${apiBase}/accounts/${accountId}/folders`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });
  } catch (err) {
    const status = err.response ? err.response.status : 0;
    const bodyStr = JSON.stringify(err.response ? err.response.data : '');
    const isRegionError = status >= 400 && status < 500 &&
      (bodyStr.includes('URL_RULE_NOT_CONFIGURED') || status === 404);
    console.log(`Zoho folders fetch failed: status=${status} body=${bodyStr} isRegionError=${isRegionError}`);
    if (isRegionError) {
      effectiveBase = await detectAndSaveApiBase(user, token);
      try {
        foldersRes = await axios.get(`${effectiveBase}/accounts/${accountId}/folders`, {
          headers: { Authorization: `Zoho-oauthtoken ${token}` }
        });
      } catch (retryErr) {
        const d = retryErr.response ? JSON.stringify(retryErr.response.data) : retryErr.message;
        throw new Error(`Zoho inbox fetch failed after region probe: ${d}`);
      }
    } else {
      const detail = err.response ? JSON.stringify(err.response.data) : err.message;
      throw new Error(`Zoho inbox fetch failed: ${detail}`);
    }
  }
  const folders = foldersRes.data.data || [];
  const inbox = folders.find(f => {
    const name = (f.folderName || f.folderid || '').toLowerCase();
    const type = (f.folderType || f.foldertype || '').toLowerCase();
    return name === 'inbox' || type === 'inbox';
  });
  if (!inbox) {
    console.error('Zoho: could not find inbox. Folders:', JSON.stringify(folders.map(f => ({ name: f.folderName, type: f.folderType, id: f.folderId }))));
    return [];
  }

  let folderId = inbox.folderId || inbox.folderid;

  // Fetch recent messages. The /folders endpoint is globally routed (200 from any
  // region), so URL_RULE_NOT_CONFIGURED only appears here. On failure we probe all
  // 5 Zoho regions directly on this same endpoint — no guesswork.
  let msgsRes;
  try {
    msgsRes = await axios.get(`${effectiveBase}/accounts/${accountId}/messages`, {
      params: { folderId, limit: 50, sortorder: 'desc' },
      headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });
  } catch (firstErr) {
    const firstBodyStr = JSON.stringify(firstErr.response ? firstErr.response.data : '');
    const firstStatus  = firstErr.response ? firstErr.response.status : 0;
    console.log(`Zoho messages first attempt: status=${firstStatus} body=${firstBodyStr}`);
    if (firstStatus >= 400 && firstStatus < 500 && firstBodyStr.includes('URL_RULE_NOT_CONFIGURED')) {
      console.log(`Zoho: wrong region detected on messages fetch — probing all regions directly`);
      let foundBase = null;
      for (const base of ZOHO_API_BASES) {
        try {
          // Try alternative URL format too: /messages?folderId=X (some Zoho versions prefer this)
          msgsRes = await axios.get(`${base}/accounts/${accountId}/messages`, {
            params: { folderId, limit: 50, sortorder: 'desc' },
            headers: { Authorization: `Zoho-oauthtoken ${token}` },
            timeout: 8000
          });
          foundBase = base;
          console.log(`Zoho probe ${base}: SUCCESS`);
          break;
        } catch (probeErr) {
          console.log(`Zoho probe ${base}: ${probeErr.response?.status} ${JSON.stringify(probeErr.response?.data)}`);
        }
      }
      if (foundBase) {
        effectiveBase = foundBase;
        user.zoho.apiBase = foundBase;
        await storage.saveUser(user);
        console.log(`Zoho: correct region found → ${foundBase} for user ${user.id}`);
      } else {
        throw new Error('Zoho inbox unreachable: no data center responded to messages endpoint');
      }
    } else {
      const detail = firstErr.response ? JSON.stringify(firstErr.response.data) : firstErr.message;
      throw new Error(`Zoho inbox fetch failed: ${detail}`);
    }
  }

  const messages = msgsRes.data.data || [];
  const results  = [];

  for (const msg of messages) {
    try {
      // Skip messages we sent
      const fromEmail = (msg.fromAddress || '').toLowerCase();
      if (fromEmail === address.toLowerCase()) continue;

      // Skip already-read messages (Zoho field is fReadStatus: "1" = read, "0" = unread)
      const isRead = msg.fReadStatus === '1' || msg.status === 'read' || msg.isRead === true;
      if (isRead) continue;

      // Fetch full message content
      const fullRes = await axios.get(
        `${effectiveBase}/accounts/${accountId}/folders/${folderId}/messages/${msg.messageId}`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
      );
      const full = fullRes.data.data || {};

      results.push({
        from:           msg.fromAddress || '',
        subject:        msg.subject     || '',
        body:           full.content    || full.htmlContent || msg.summary || '',
        gmailMessageId: String(msg.messageId),
        gmailThreadId:  null,
        timestamp:      msg.receivedTime ? new Date(Number(msg.receivedTime)).toISOString() : new Date().toISOString(),
        messageId:      msg.inReplyTo || msg['message-id'] || String(msg.messageId),
        resumeAttachment: null
      });

      // Mark as read
      await axios.put(
        `${effectiveBase}/accounts/${accountId}/updatemessage`,
        { mode: 'markAsRead', messageId: [String(msg.messageId)] },
        { headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' } }
      ).catch(e => console.error('Zoho markAsRead error:', e.message));
    } catch (e) {
      console.error('Zoho fetch message error:', e.response ? JSON.stringify(e.response.data) : e.message);
    }
  }

  return results;
}

// ── Sent address scan for duplicate check ────────────────────────────────────
async function getSentAddresses(userId) {
  const user = await storage.getUserById(userId);
  if (!user || !user.zoho || !user.zoho.connected) return [];

  try {
    const token = await getAccessToken(user);
    const { accountId } = user.zoho;

    const foldersRes = await axios.get(`${userApiBase(user)}/accounts/${accountId}/folders`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });
    const sent = (foldersRes.data.data || []).find(f =>
      f.folderName.toLowerCase() === 'sent' || f.folderType === 'sent'
    );
    if (!sent) return [];

    const msgsRes = await axios.get(`${userApiBase(user)}/accounts/${accountId}/folders/${sent.folderId}/messages/view`, {
      params: { limit: 200 },
      headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });

    const addresses = new Set();
    for (const msg of msgsRes.data.data || []) {
      const to = msg.toAddress || '';
      const found = to.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
      found.forEach(e => addresses.add(e.toLowerCase()));
    }
    return [...addresses];
  } catch { return []; }
}

module.exports = { getAuthUrl, exchangeCode, revokeTokens, sendEmail, fetchUnreadReplies, getSentAddresses };
