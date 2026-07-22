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

// Upload a file to Zoho's attachment store, returning the reference object
// the send endpoint expects. Zoho requires attachments to be pre-uploaded
// (raw binary POST) before referencing them in a send — they can't be
// inlined in the send payload itself.
async function uploadAttachment(apiBase, accountId, token, attachment) {
  const url = `${apiBase}/accounts/${accountId}/messages/attachments?fileName=${encodeURIComponent(attachment.filename)}`;
  // Zoho's upload endpoint 415s on the file's real MIME type (e.g.
  // application/pdf) — it only accepts raw binary declared as octet-stream;
  // the fileName query param carries the actual type/name.
  const res = await axios.post(url, attachment.content, {
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/octet-stream'
    }
  });
  // Zoho returns data as an object for single raw uploads but as an array in
  // some regions/modes — accept both.
  const d = res.data && res.data.data;
  const info = Array.isArray(d) ? d[0] : d;
  if (!info || !info.storeName) {
    throw new Error('Zoho attachment upload returned no storeName: ' + JSON.stringify(res.data));
  }
  return {
    storeName: info.storeName,
    attachmentPath: info.attachmentPath,
    attachmentName: attachment.filename
  };
}

// ── Send email via Zoho REST API ──────────────────────────────────────────────
async function sendEmail(userId, { to, cc, subject, body, inReplyTo, references, trackingId, attachments }) {
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
  if (cc) payload.ccAddress = cc;
  if (inReplyTo) payload.inReplyTo = inReplyTo;

  let apiBase = userApiBase(user);

  // Attachments must be uploaded to Zoho's store before the send references
  // them. The email's whole point may be the attachment (role JD PDF), so a
  // failed upload FAILS the send — never silently deliver without it.
  if (attachments && attachments.length) {
    async function uploadAll(base) {
      const uploaded = [];
      for (const att of attachments) {
        uploaded.push(await uploadAttachment(base, accountId, token, att));
      }
      return uploaded;
    }
    try {
      payload.attachments = await uploadAll(apiBase);
    } catch (attErr) {
      // The upload runs before the send's own wrong-region fallback can fire,
      // so a stale apiBase hits here first. Re-detect the region and retry
      // once; any other failure propagates.
      const errBody = attErr.response ? attErr.response.data : null;
      const wrongRegion = errBody && (
        (errBody.data && errBody.data.errorCode === 'URL_RULE_NOT_CONFIGURED') ||
        (errBody.status && errBody.status.code === 404)
      );
      if (!wrongRegion) {
        const detail = attErr.response ? `${attErr.response.status} ${JSON.stringify(attErr.response.data)}` : attErr.message;
        throw new Error('Zoho attachment upload failed — email NOT sent: ' + detail);
      }
      console.log('Zoho: attachment upload hit wrong region, re-detecting…');
      apiBase = await detectAndSaveApiBase(user, token);
      payload.attachments = await uploadAll(apiBase);
    }
  }
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

  // Zoho returns HTTP 200 even for some send failures, with the real outcome
  // in the body's status.code (e.g. an invalid/unverified fromAddress). axios
  // only throws on non-2xx, so without checking the body a rejected send looks
  // like success — the job gets marked sent, but nothing actually goes out and
  // nothing lands in the Sent folder. Treat a non-200 body (or a success body
  // with no messageId) as a real failure so it surfaces instead of silently
  // "sending" nothing.
  const bodyStatus = resp.data && resp.data.status ? resp.data.status.code : undefined;
  const sentMessageId = resp.data && resp.data.data ? resp.data.data.messageId : undefined;
  if ((bodyStatus !== undefined && bodyStatus !== 200) || (bodyStatus === 200 && !sentMessageId)) {
    const detail = JSON.stringify(resp.data);
    console.error('Zoho send returned a non-success body (email NOT sent):', detail);
    throw new Error(`Zoho send failed — Zoho responded: ${detail}`);
  }
  const msgId = sentMessageId || uuidv4();
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

  // Correct Zoho endpoint: GET /accounts/{accountId}/messages/view?folderId={folderId}
  // folderId is a QUERY PARAM, not part of the URL path.
  const msgsRes = await axios.get(`${effectiveBase}/accounts/${accountId}/messages/view`, {
    params: { folderId, limit: 50 },
    headers: { Authorization: `Zoho-oauthtoken ${token}` }
  }).catch(err => {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Zoho inbox fetch failed: ${detail}`);
  });

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

      // Fetch full message content — Zoho API: /folders/{folderId}/messages/{messageId}/content
      const fullRes = await axios.get(
        `${effectiveBase}/accounts/${accountId}/folders/${folderId}/messages/${msg.messageId}/content`,
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

module.exports = { getAuthUrl, exchangeCode, revokeTokens, sendEmail, fetchUnreadReplies, getSentAddresses, getAccessToken };
