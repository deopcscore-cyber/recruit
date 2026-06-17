/* ============================================================
   Welltower Recruiter — Zoho Mail Service (OAuth2 REST API)
   SMTP is blocked on Railway — Zoho's HTTPS API is used instead.
   ============================================================ */

const axios   = require('axios');
const { v4: uuidv4 } = require('uuid');
const storage = require('./storage');
const { BASE_URL, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET } = require('../config');
const { buildRawEmailParts, buildSignatureHtml, buildSignaturePlainText } = require('./gmail');

const TOKEN_URL = 'https://accounts.zoho.com/oauth/v2/token';
const API_BASE  = 'https://mail.zoho.com/api';

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

  // Fetch the account ID and address
  const { accountId, address } = await fetchAccountInfo(data.access_token);

  user.zoho = {
    connected:    true,
    address:      (address || '').toLowerCase(),
    accountId,
    accessToken:  data.access_token,
    refreshToken: data.refresh_token,
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
  await storage.saveUser(user);
  return user.zoho.accessToken;
}

async function getAccessToken(user) {
  if (!user.zoho || !user.zoho.connected) throw new Error('Zoho not connected');
  if (Date.now() < (user.zoho.expiresAt || 0) - 60000) return user.zoho.accessToken;
  return refreshTokens(user);
}

async function fetchAccountInfo(accessToken) {
  const { data } = await axios.get(`${API_BASE}/accounts`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }
  });
  const acct = data.data && data.data[0];
  if (!acct) throw new Error('No Zoho account found');

  // Log the full account object once so we can see exactly what Zoho returns
  console.log('Zoho account object:', JSON.stringify(acct, null, 2));

  // Zoho returns the email in different fields depending on account type
  const address = acct.emailAddress || acct.mailId || acct.primaryEmailAddress
    || (Array.isArray(acct.emailAlias) && acct.emailAlias[0])
    || '';

  if (!address) {
    console.error('Zoho account fields returned:', Object.keys(acct));
    throw new Error('Could not read email address from Zoho account');
  }

  return { accountId: acct.accountId, address };
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

  const fromName = user.name || '';
  const fromAddr = fromName ? `${fromName} <${address}>` : address;

  const payload = {
    fromAddress: fromAddr,
    toAddress:   to,
    subject,
    content:     htmlBody,
    mailFormat:  'html'
  };
  if (inReplyTo) payload.inReplyTo = inReplyTo;

  const { data } = await axios.post(
    `${API_BASE}/accounts/${accountId}/messages`,
    payload,
    { headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' } }
  );

  const msgId = (data.data && data.data.messageId) || uuidv4();
  return { gmailMessageId: null, gmailThreadId: null, smtpMessageId: String(msgId) };
}

// ── Fetch unread replies via Zoho REST API ────────────────────────────────────
async function fetchUnreadReplies(userId) {
  const user = await storage.getUserById(userId);
  if (!user) throw new Error('User not found');

  const token = await getAccessToken(user);
  const { accountId, address } = user.zoho;

  // Fetch INBOX folder ID
  const foldersRes = await axios.get(`${API_BASE}/accounts/${accountId}/folders`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` }
  });
  const inbox = (foldersRes.data.data || []).find(f =>
    f.folderName.toLowerCase() === 'inbox' || f.folderType === 'inbox'
  );
  if (!inbox) return [];

  // Get unread messages
  const msgsRes = await axios.get(`${API_BASE}/accounts/${accountId}/folders/${inbox.folderId}/messages/view`, {
    params: { status: 'unread', limit: 50 },
    headers: { Authorization: `Zoho-oauthtoken ${token}` }
  });

  const messages = msgsRes.data.data || [];
  const results  = [];

  for (const msg of messages) {
    try {
      // Skip messages we sent
      const fromEmail = (msg.fromAddress || '').toLowerCase();
      if (fromEmail === address.toLowerCase()) continue;

      // Fetch full message content
      const fullRes = await axios.get(
        `${API_BASE}/accounts/${accountId}/folders/${inbox.folderId}/messages/${msg.messageId}`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
      );
      const full = fullRes.data.data || {};

      results.push({
        from:           msg.fromAddress || '',
        subject:        msg.subject     || '',
        body:           full.content    || msg.summary || '',
        gmailMessageId: String(msg.messageId),
        gmailThreadId:  null,
        timestamp:      msg.receivedTime ? new Date(Number(msg.receivedTime)).toISOString() : new Date().toISOString(),
        messageId:      String(msg.messageId),
        resumeAttachment: null
      });

      // Mark as read
      await axios.put(
        `${API_BASE}/accounts/${accountId}/updatemessage`,
        { mode: 'markAsRead', messageId: [String(msg.messageId)] },
        { headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' } }
      ).catch(() => {});
    } catch (e) {
      console.error('Zoho fetch message error:', e.message);
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

    const foldersRes = await axios.get(`${API_BASE}/accounts/${accountId}/folders`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });
    const sent = (foldersRes.data.data || []).find(f =>
      f.folderName.toLowerCase() === 'sent' || f.folderType === 'sent'
    );
    if (!sent) return [];

    const msgsRes = await axios.get(`${API_BASE}/accounts/${accountId}/folders/${sent.folderId}/messages/view`, {
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

module.exports = { getAuthUrl, exchangeCode, sendEmail, fetchUnreadReplies, getSentAddresses };
