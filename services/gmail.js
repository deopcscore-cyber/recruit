const { google } = require('googleapis');
const storage = require('./storage');
const { BASE_URL } = require('../config');

// ─── Markdown → HTML converter (used for JD emails) ──────────────────────────
function inlineFormat(text) {
  return text
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/_{1,2}([^_]+)_{1,2}/g, '<em>$1</em>');
}

function markdownToHtml(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const out = [];
  let inList = false;
  let inNumberedList = false;

  const closeList = () => {
    if (inList)        { out.push('</ul>'); inList = false; }
    if (inNumberedList){ out.push('</ol>'); inNumberedList = false; }
  };

  for (const line of lines) {
    // Setext-style heading (underline ===)
    // ATX headers
    const h3 = line.match(/^###\s+(.+)$/);
    const h2 = line.match(/^##\s+(.+)$/);
    const h1 = line.match(/^#\s+(.+)$/);
    if (h1 || h2 || h3) {
      closeList();
      const lv = h1 ? 1 : h2 ? 2 : 3;
      const txt = (h1 || h2 || h3)[1];
      const sz = lv === 1 ? '22px' : lv === 2 ? '18px' : '15px';
      out.push(`<h${lv} style="margin:22px 0 6px;font-size:${sz};color:#1a1a2e;font-family:Georgia,serif">${inlineFormat(txt)}</h${lv}>`);
      continue;
    }

    // Horizontal rule
    if (line.match(/^[-*_]{3,}\s*$/)) {
      closeList();
      out.push('<hr style="border:none;border-top:1px solid #dde3f0;margin:18px 0">');
      continue;
    }

    // Bullet list item
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (!inList) { out.push('<ul style="margin:6px 0 6px 0;padding-left:22px">'); inList = true; }
      out.push(`<li style="margin:4px 0;color:#2d2d2d">${inlineFormat(bullet[1])}</li>`);
      continue;
    }

    // Numbered list item
    const numbered = line.match(/^\d+\.\s+(.+)$/);
    if (numbered) {
      if (!inNumberedList) { out.push('<ol style="margin:6px 0;padding-left:22px">'); inNumberedList = true; }
      out.push(`<li style="margin:4px 0">${inlineFormat(numbered[1])}</li>`);
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      closeList();
      out.push('<div style="height:8px"></div>');
      continue;
    }

    // Italic-only line (e.g. *Confidential | Prepared exclusively for Scott*)
    const italicLine = line.match(/^\*(.+)\*$/);
    if (italicLine) {
      closeList();
      out.push(`<p style="margin:6px 0;color:#777;font-style:italic;font-size:13px">${inlineFormat(italicLine[1])}</p>`);
      continue;
    }

    // Regular paragraph
    closeList();
    out.push(`<p style="margin:5px 0;color:#2d2d2d;line-height:1.6">${inlineFormat(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

// Detect if text contains markdown (not already HTML)
function hasMarkdown(text) {
  return /^#{1,3}\s/m.test(text) || /\*\*/.test(text) || /^[-*]\s/m.test(text) || /^---/m.test(text);
}

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

  let htmlBody;
  if (body.includes('<p') || body.includes('<h') || body.includes('<div')) {
    // Already HTML
    htmlBody = body;
  } else if (hasMarkdown(body)) {
    // Markdown → styled HTML (used for JD emails)
    const converted = markdownToHtml(body);
    htmlBody = `<div style="max-width:640px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#2d2d2d;padding:24px 16px">${converted}</div>`;
  } else {
    // Plain text → preserve line breaks
    htmlBody = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#2d2d2d">${body.replace(/\n/g, '<br>')}</div>`;
  }
  const fullHtml = `<html><body>${htmlBody}${pixel}</body></html>`;

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8'
  ];

  if (inReplyTo) {
    // inReplyTo must be the full SMTP Message-ID (may already include angle brackets)
    const bracket = inReplyTo.startsWith('<') ? inReplyTo : `<${inReplyTo}>`;
    headers.push(`In-Reply-To: ${bracket}`);
    headers.push(`References: ${bracket}`);
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

  // Fetch the sent message to retrieve its SMTP Message-ID header.
  // This is required for correct In-Reply-To / References threading in replies.
  let smtpMessageId = '';
  try {
    const sent = await gmail.users.messages.get({
      userId: 'me',
      id: response.data.id,
      format: 'metadata',
      metadataHeaders: ['Message-ID']
    });
    const msgIdHeader = (sent.data.payload.headers || [])
      .find(h => h.name.toLowerCase() === 'message-id');
    if (msgIdHeader) {
      smtpMessageId = msgIdHeader.value.replace(/^<|>$/g, '');
    }
  } catch (err) {
    console.error('Could not fetch sent message SMTP Message-ID:', err.message);
  }

  return {
    gmailMessageId: response.data.id,
    gmailThreadId: response.data.threadId,
    smtpMessageId
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

      // Detect resume attachments (PDF / Word / RTF)
      const resumeAttachment = await extractResumeAttachment(gmail, msg.id, msgData.payload);

      results.push({
        from,
        subject,
        body,
        gmailMessageId: msgData.id,
        gmailThreadId: msgData.threadId,
        timestamp: dateStr ? new Date(dateStr).toISOString() : new Date().toISOString(),
        messageId: messageId ? messageId.replace(/[<>]/g, '') : '',
        resumeAttachment   // { filename, mimeType, buffer } or null
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

// Recursively find PDF/Word attachment parts in an email payload
function getAttachmentParts(payload) {
  const parts = [];
  function walk(p) {
    if (!p) return;
    const mime = (p.mimeType || '').toLowerCase();
    const resumeMimes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-word',
      'application/rtf',
      'text/rtf'
    ];
    if (resumeMimes.includes(mime) && p.body && p.body.attachmentId && p.filename) {
      parts.push({ attachmentId: p.body.attachmentId, filename: p.filename, mimeType: mime });
    }
    if (p.parts) p.parts.forEach(walk);
  }
  walk(payload);
  return parts;
}

async function extractResumeAttachment(gmail, messageId, payload) {
  try {
    const attParts = getAttachmentParts(payload);
    if (attParts.length === 0) return null;
    const info = attParts[0]; // take first resume-like attachment
    const attRes = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: info.attachmentId
    });
    // Gmail returns base64url-encoded data
    const base64 = attRes.data.data.replace(/-/g, '+').replace(/_/g, '/');
    const buffer = Buffer.from(base64, 'base64');
    return { filename: info.filename, mimeType: info.mimeType, buffer };
  } catch (err) {
    console.error('Could not download attachment:', err.message);
    return null;
  }
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
