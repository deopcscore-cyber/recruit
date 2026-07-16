/* ============================================================
   Recruit Pro — Microsoft Outlook (Graph API) Service
   Supports personal @outlook.com / @hotmail.com accounts.
   ============================================================ */

const axios   = require('axios');
const { v4: uuidv4 } = require('uuid');
const storage = require('./storage');
const { BASE_URL, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET } = require('../config');
const { buildSignatureHtml, buildSignaturePlainText } = require('./gmail');

const TENANT       = 'consumers'; // personal Microsoft accounts only
const AUTH_BASE    = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;
const GRAPH_BASE   = 'https://graph.microsoft.com/v1.0';
const SCOPES       = 'openid email profile offline_access Mail.Send Mail.ReadWrite';
const REDIRECT_URI = `${BASE_URL}/auth/outlook/callback`;

// ── OAuth2 ────────────────────────────────────────────────────────────────────

// `state` is an opaque CSRF nonce verified against the session on callback —
// never a user ID (that allowed account takeover).
function getAuthUrl(state) {
  if (!MICROSOFT_CLIENT_ID) throw new Error('MICROSOFT_CLIENT_ID not configured');
  const params = new URLSearchParams({
    client_id:     MICROSOFT_CLIENT_ID,
    response_type: 'code',
    redirect_uri:  REDIRECT_URI,
    scope:         SCOPES,
    state,
    response_mode: 'query'
  });
  return `${AUTH_BASE}/authorize?${params}`;
}

async function exchangeCode(userId, code) {
  const params = new URLSearchParams({
    client_id:     MICROSOFT_CLIENT_ID,
    client_secret: MICROSOFT_CLIENT_SECRET,
    grant_type:    'authorization_code',
    code,
    redirect_uri:  REDIRECT_URI,
    scope:         SCOPES
  });

  const { data } = await axios.post(`${AUTH_BASE}/token`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  if (!data.access_token) throw new Error('No access token from Microsoft');

  // Fetch profile
  const { data: profile } = await axios.get(`${GRAPH_BASE}/me`, {
    headers: { Authorization: `Bearer ${data.access_token}` }
  });
  const address = (profile.mail || profile.userPrincipalName || '').toLowerCase();

  const user = await storage.getUserById(userId);
  if (!user) throw new Error('User not found');

  user.outlook = {
    connected:    true,
    address,
    accessToken:  data.access_token,
    refreshToken: data.refresh_token || '',
    expiresAt:    Date.now() + (data.expires_in || 3600) * 1000
  };
  await storage.saveUser(user);
  return user.outlook;
}

async function refreshTokens(user) {
  if (!user.outlook?.refreshToken) throw new Error('No Outlook refresh token');
  const params = new URLSearchParams({
    client_id:     MICROSOFT_CLIENT_ID,
    client_secret: MICROSOFT_CLIENT_SECRET,
    grant_type:    'refresh_token',
    refresh_token: user.outlook.refreshToken,
    scope:         SCOPES
  });
  const { data } = await axios.post(`${AUTH_BASE}/token`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  if (!data.access_token) throw new Error('Outlook token refresh failed');
  user.outlook.accessToken  = data.access_token;
  if (data.refresh_token) user.outlook.refreshToken = data.refresh_token;
  user.outlook.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  await storage.saveUser(user);
  return user.outlook;
}

async function getAccessToken(user) {
  if (!user.outlook?.accessToken) throw new Error('Outlook not connected');
  const MARGIN = 5 * 60 * 1000;
  if (Date.now() + MARGIN >= (user.outlook.expiresAt || 0)) {
    const updated = await refreshTokens(user);
    return updated.accessToken;
  }
  return user.outlook.accessToken;
}

// ── Send email ────────────────────────────────────────────────────────────────

async function sendEmail(userId, { to, subject, body, trackingId, inReplyTo, references, attachments }) {
  const user  = await storage.getUserById(userId);
  const token = await getAccessToken(user);

  // Build HTML with tracking pixel + signature
  const sigHtml   = buildSignatureHtml(user);
  const sigPlain  = buildSignaturePlainText(user);
  const trackPx   = trackingId
    ? `<img src="${BASE_URL}/track/${trackingId}.png" width="1" height="1" style="display:none" />`
    : '';
  const htmlContent = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6">${body.replace(/\n/g, '<br>')}${sigHtml}</div>${trackPx}`;
  const plainContent = body + sigPlain;

  const message = {
    subject,
    body: { contentType: 'HTML', content: htmlContent },
    toRecipients: [{ emailAddress: { address: to } }]
  };

  // Threading headers
  if (inReplyTo) {
    message.internetMessageHeaders = [
      { name: 'In-Reply-To', value: `<${inReplyTo.replace(/^<|>$/g, '')}>` },
      { name: 'References',  value: references || `<${inReplyTo.replace(/^<|>$/g, '')}>` }
    ];
  }

  if (attachments && attachments.length) {
    message.attachments = attachments.map(a => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.filename,
      contentType: a.contentType || 'application/octet-stream',
      contentBytes: a.content.toString('base64')
    }));
  }

  await axios.post(`${GRAPH_BASE}/me/sendMail`, { message, saveToSentItems: true }, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });

  // Retrieve the sent message to get its ID + conversationId
  let smtpMessageId = `<${uuidv4()}@recruit-pro.app>`;
  let conversationId = '';
  try {
    const { data: sent } = await axios.get(`${GRAPH_BASE}/me/mailFolders/SentItems/messages`, {
      params: { $top: 1, $orderby: 'sentDateTime desc', $select: 'id,conversationId,internetMessageId' },
      headers: { Authorization: `Bearer ${token}` }
    });
    const m = sent.value?.[0];
    if (m) {
      smtpMessageId  = m.internetMessageId || smtpMessageId;
      conversationId = m.conversationId    || '';
    }
  } catch { /* non-fatal — use generated ID */ }

  return {
    gmailMessageId: smtpMessageId,
    gmailThreadId:  conversationId,
    smtpMessageId
  };
}

// ── Fetch unread replies ──────────────────────────────────────────────────────

async function fetchUnreadReplies(userId, candidateEmails, candidateThreadIds) {
  const user = await storage.getUserById(userId);
  if (!user?.outlook?.connected) return [];

  let token;
  try { token = await getAccessToken(user); }
  catch { return []; }

  // Fetch unread messages from inbox
  let messages = [];
  try {
    const { data } = await axios.get(`${GRAPH_BASE}/me/messages`, {
      params: {
        $filter: 'isRead eq false and isDraft eq false',
        $top: 50,
        $select: 'id,subject,from,body,receivedDateTime,conversationId,internetMessageId'
      },
      headers: { Authorization: `Bearer ${token}` }
    });
    messages = data.value || [];
  } catch { return []; }

  const replies = [];
  for (const msg of messages) {
    const fromEmail = (msg.from?.emailAddress?.address || '').toLowerCase();
    const matchEmail  = candidateEmails.some(e => e.toLowerCase() === fromEmail);
    const matchThread = candidateThreadIds?.[msg.conversationId];
    if (!matchEmail && !matchThread) continue;

    // Mark as read
    try {
      await axios.patch(`${GRAPH_BASE}/me/messages/${msg.id}`,
        { isRead: true },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );
    } catch { /* non-fatal */ }

    replies.push({
      candidateEmail: fromEmail,
      conversationId: msg.conversationId,
      messageId:      msg.internetMessageId || msg.id,
      subject:        msg.subject  || '',
      body:           msg.body?.content || '',
      receivedAt:     msg.receivedDateTime
    });
  }
  return replies;
}

module.exports = { getAuthUrl, exchangeCode, sendEmail, fetchUnreadReplies };
