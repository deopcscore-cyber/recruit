const { google } = require('googleapis');
const storage = require('./storage');
const { BASE_URL } = require('../config');

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    `${BASE_URL}/auth/gmail/callback`
  );
}

function getAuthUrl(userId) {
  const oauth2Client = createOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/userinfo.email'
    ],
    state: userId
  });
}

async function exchangeCode(userId, code) {
  const oauth2Client = createOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  // Get user email address
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const { data } = await oauth2.userinfo.get();

  const user = await storage.getUserById(userId);
  if (!user) throw new Error('User not found');

  user.gmail = {
    connected: true,
    tokens,
    address: data.email || ''
  };
  await storage.saveUser(user);
  return user;
}

async function getAuthedClient(user) {
  if (!user.gmail || !user.gmail.tokens) throw new Error('Gmail not connected');
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials(user.gmail.tokens);

  // Auto-refresh token if expired
  oauth2Client.on('tokens', async (newTokens) => {
    if (newTokens.refresh_token) {
      user.gmail.tokens.refresh_token = newTokens.refresh_token;
    }
    user.gmail.tokens.access_token = newTokens.access_token;
    if (newTokens.expiry_date) {
      user.gmail.tokens.expiry_date = newTokens.expiry_date;
    }
    await storage.saveUser(user);
  });

  return oauth2Client;
}

function buildRawEmail({ from, to, subject, body, threadId, inReplyTo, trackingId, baseUrl }) {
  const pixel = trackingId
    ? `<img src="${baseUrl}/track/${trackingId}" width="1" height="1" style="display:none" />`
    : '';

  const htmlBody = body.includes('<') ? body : body.replace(/\n/g, '<br>');
  const fullHtml = `<html><body>${htmlBody}${pixel}</body></html>`;

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8'
  ];

  if (inReplyTo) {
    headers.push(`In-Reply-To: <${inReplyTo}>`);
    headers.push(`References: <${inReplyTo}>`);
  }

  const rawEmail = headers.join('\r\n') + '\r\n\r\n' + fullHtml;

  // Base64url encode
  return Buffer.from(rawEmail)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sendEmail(userId, { to, subject, body, threadId, inReplyTo, trackingId }) {
  const user = await storage.getUserById(userId);
  if (!user) throw new Error('User not found');

  const auth = await getAuthedClient(user);
  const gmail = google.gmail({ version: 'v1', auth });

  const from = user.gmail.address || 'me';

  const raw = buildRawEmail({
    from,
    to,
    subject,
    body,
    threadId,
    inReplyTo,
    trackingId,
    baseUrl: BASE_URL
  });

  const requestBody = { raw };
  if (threadId) requestBody.threadId = threadId;

  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody
  });

  return {
    gmailMessageId: response.data.id,
    gmailThreadId: response.data.threadId
  };
}

async function fetchUnreadReplies(userId) {
  const user = await storage.getUserById(userId);
  if (!user) throw new Error('User not found');

  const auth = await getAuthedClient(user);
  const gmail = google.gmail({ version: 'v1', auth });

  const listResponse = await gmail.users.messages.list({
    userId: 'me',
    q: 'is:unread in:inbox',
    maxResults: 50
  });

  const messages = listResponse.data.messages || [];
  const results = [];

  for (const msg of messages) {
    try {
      const msgResponse = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full'
      });

      const msgData = msgResponse.data;
      const headers = msgData.payload.headers || [];

      const getHeader = (name) => {
        const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
        return h ? h.value : '';
      };

      const from = getHeader('From');
      const subject = getHeader('Subject');
      const dateStr = getHeader('Date');
      const messageId = getHeader('Message-ID');

      const body = parseEmailBody(msgData.payload);

      results.push({
        from,
        subject,
        body,
        gmailMessageId: msgData.id,
        gmailThreadId: msgData.threadId,
        timestamp: dateStr ? new Date(dateStr).toISOString() : new Date().toISOString(),
        messageId: messageId ? messageId.replace(/[<>]/g, '') : ''
      });

      // Mark as read
      await gmail.users.messages.modify({
        userId: 'me',
        id: msg.id,
        requestBody: { removeLabelIds: ['UNREAD'] }
      });
    } catch (err) {
      console.error(`Error fetching message ${msg.id}:`, err.message);
    }
  }

  return results;
}

function parseEmailBody(payload) {
  if (!payload) return '';

  // Direct body
  if (payload.body && payload.body.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }

  // Multipart — prefer text/plain, fall back to text/html
  if (payload.parts && payload.parts.length > 0) {
    let textPlain = '';
    let textHtml = '';

    for (const part of payload.parts) {
      const mimeType = part.mimeType || '';
      if (mimeType === 'text/plain' && part.body && part.body.data) {
        textPlain = Buffer.from(part.body.data, 'base64').toString('utf8');
      } else if (mimeType === 'text/html' && part.body && part.body.data) {
        textHtml = Buffer.from(part.body.data, 'base64').toString('utf8');
      } else if (mimeType.startsWith('multipart/')) {
        // Recurse into nested multipart
        const nested = parseEmailBody(part);
        if (nested) {
          if (!textPlain) textPlain = nested;
        }
      }
    }

    return textPlain || textHtml || '';
  }

  return '';
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  getAuthedClient,
  sendEmail,
  fetchUnreadReplies,
  parseEmailBody
};
