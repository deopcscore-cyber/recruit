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

function stripToPlainText(body) {
  return body
    .replace(/<[^>]+>/g, '')          // strip HTML tags
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1') // strip bold+italic markdown
    .replace(/\*\*(.+?)\*\*/g, '$1')  // strip bold markdown
    .replace(/\*(.+?)\*/g, '$1')      // strip italic markdown
    .replace(/^#{1,3}\s+/gm, '')      // strip ATX headers
    .replace(/^[-*]\s+/gm, '• ')      // convert bullets to unicode
    .replace(/^[-─═]{3,}\s*$/gm, '---') // convert horizontal rules
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')       // collapse excess blank lines
    .trim();
}

function buildRawEmail({ from, to, subject, body, signatureHtml = '', signaturePlain = '', threadId, inReplyTo, references, trackingId, baseUrl }) {
  const boundary = `_wt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  // ── Plain-text part ───────────────────────────────────────────────────────────
  // Strip only the email body — signature plain text is appended separately
  const plainText = stripToPlainText(body) + (signaturePlain || '');

  // ── HTML part — detect format of body ONLY (never include signature in detection) ──
  const pixel = trackingId
    ? `<img src="${baseUrl}/track/${trackingId}" width="1" height="1" style="display:none" />`
    : '';

  let htmlBody;
  if (body.includes('<p') || body.includes('<h') || body.includes('<div')) {
    // Already HTML
    htmlBody = body;
  } else if (hasMarkdown(body)) {
    const converted = markdownToHtml(body);
    htmlBody = `<div style="max-width:640px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#2d2d2d;padding:24px 16px">${converted}</div>`;
  } else {
    // Plain text — convert newlines to <br>
    htmlBody = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#2d2d2d">${body.replace(/\n/g, '<br>')}</div>`;
  }

  // Signature is appended AFTER body conversion, separately from detection above
  const fullHtml = `<html><body>${htmlBody}${signatureHtml}${pixel}</body></html>`;

  // ── Headers ──────────────────────────────────────────────────────────────────
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Date: ${new Date().toUTCString()}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  ];

  if (inReplyTo) {
    const bracket = inReplyTo.startsWith('<') ? inReplyTo : `<${inReplyTo}>`;
    headers.push(`In-Reply-To: ${bracket}`);
    headers.push(`References: ${references || bracket}`);
  }

  // ── Assemble multipart/alternative body ──────────────────────────────────────
  const rawEmail = [
    headers.join('\r\n'),
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    plainText,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    fullHtml,
    '',
    `--${boundary}--`
  ].join('\r\n');

  return Buffer.from(rawEmail)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sendEmail(userId, { to, subject, body, threadId, inReplyTo, references, trackingId }) {
  const user = await storage.getUserById(userId);
  if (!user) throw new Error('User not found');

  const auth = await getAuthedClient(user);
  const gmail = google.gmail({ version: 'v1', auth });

  // Build "Display Name <email>" — this is what recipients see as the sender name
  const fromEmail = user.gmail.address || '';
  const fromName  = user.name || '';
  const from = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;

  // Signature is passed separately so buildRawEmail can detect the body format correctly
  const signatureHtml  = buildSignatureHtml(user);
  const signaturePlain = buildSignaturePlainText(user);

  const raw = buildRawEmail({ from, to, subject, body, signatureHtml, signaturePlain, threadId, inReplyTo, references, trackingId, baseUrl: BASE_URL });

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
    q: '-from:me newer_than:14d',  // no unread filter — user may have read on phone/browser
    maxResults: 100
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

// ─── Email Signature Builder (premium) ────────────────────────────────────────
function buildSignatureHtml(user) {
  const sig = user.signature || {};
  if (!sig.enabled) return '';

  const name       = (user.name  || '').trim();
  const title      = (user.title || 'Senior Talent Acquisition Coordinator').trim();
  const company    = 'Welltower Inc.';
  const ticker     = 'NYSE: WELL';
  const photo      = (sig.photoUrl  || '').trim();
  const website    = (sig.website   || '').trim();
  const location   = (sig.location  || '').trim();
  const linkedin   = (sig.linkedin  || '').trim();
  const facebook   = (sig.facebook  || '').trim();
  const twitter    = (sig.twitter   || '').trim();
  const disclaimer = (sig.disclaimer|| '').trim();

  // ── Circular photo ────────────────────────────────────────────────────────
  const photoCell = photo
    ? `<td width="88" style="padding:0 16px 0 0;vertical-align:top">
         <img src="${photo}" width="72" height="72" alt="${name}"
              style="display:block;border-radius:50%;width:72px;height:72px;object-fit:cover;border:3px solid #1a3e72" />
       </td>`
    : '';

  // ── Contact info line ─────────────────────────────────────────────────────
  const contactParts = [];
  if (location) contactParts.push(`<span style="color:#64748b;font-family:Arial,sans-serif;font-size:12px">${location}</span>`);
  if (website)  contactParts.push(`<a href="${website}" target="_blank" style="color:#1a3e72;text-decoration:none;font-family:Arial,sans-serif;font-size:12px">${website.replace(/^https?:\/\//, '')}</a>`);
  const contactLine = contactParts.length
    ? `<p style="margin:5px 0 0;font-family:Arial,sans-serif;font-size:12px;line-height:1.5;color:#64748b">${contactParts.join('&nbsp;&nbsp;·&nbsp;&nbsp;')}</p>`
    : '';

  // ── Social links (text-style, not badge buttons) ──────────────────────────
  const socialLinks = [];
  if (linkedin) socialLinks.push(`<a href="${linkedin}" target="_blank" style="color:#1a3e72;text-decoration:none;font-family:Arial,sans-serif;font-size:12px;font-weight:600">LinkedIn</a>`);
  if (facebook) socialLinks.push(`<a href="${facebook}" target="_blank" style="color:#1a3e72;text-decoration:none;font-family:Arial,sans-serif;font-size:12px;font-weight:600">Facebook</a>`);
  if (twitter)  socialLinks.push(`<a href="${twitter}"  target="_blank" style="color:#1a3e72;text-decoration:none;font-family:Arial,sans-serif;font-size:12px;font-weight:600">X / Twitter</a>`);
  const socialRow = socialLinks.length
    ? `<tr><td colspan="2" style="padding-top:10px">
         <p style="margin:0;font-family:Arial,sans-serif;font-size:12px;color:#64748b">${socialLinks.join('&nbsp;&nbsp;·&nbsp;&nbsp;')}</p>
       </td></tr>`
    : '';

  // ── Disclaimer ────────────────────────────────────────────────────────────
  const disclaimerBlock = disclaimer
    ? `<tr><td colspan="2" style="padding-top:12px;border-top:1px solid #e2e8f0">
         <p style="margin:0;font-size:10px;color:#94a3b8;line-height:1.5;font-family:Arial,sans-serif">${disclaimer}</p>
       </td></tr>`
    : '';

  return `
<div style="margin-top:28px;padding-top:20px;border-top:2px solid #1a3e72;max-width:560px">
  <p style="margin:0 0 16px;font-size:15px;font-family:Georgia,'Times New Roman',serif;color:#374151;font-style:italic">Sincerely,</p>
  <table border="0" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
    <tr>
      ${photoCell}
      <td style="vertical-align:top;border-left:3px solid #1a3e72;padding-left:14px">
        <p style="margin:0;font-size:15px;font-weight:700;color:#0f172a;font-family:Arial,sans-serif;line-height:1.3">${name}</p>
        <p style="margin:3px 0 0;font-size:12px;color:#475569;font-family:Arial,sans-serif;line-height:1.4">${title}</p>
        <p style="margin:3px 0 0;font-size:12px;font-weight:600;color:#1a3e72;font-family:Arial,sans-serif;line-height:1.4">${company}&nbsp;&nbsp;<span style="color:#94a3b8;font-weight:400">|</span>&nbsp;&nbsp;<span style="color:#64748b;font-weight:400">${ticker}</span></p>
        ${contactLine}
      </td>
    </tr>
    ${socialRow}
    ${disclaimerBlock}
  </table>
</div>`;
}

function buildSignaturePlainText(user) {
  const sig = user.signature || {};
  if (!sig.enabled) return '';
  const name    = user.name  || '';
  const title   = user.title || 'Senior Talent Acquisition Coordinator';
  const lines = [
    '',
    '—',
    name,
    title,
    'Welltower Inc. | NYSE: WELL'
  ];
  if (sig.website)  lines.push(sig.website);
  if (sig.location) lines.push(sig.location);
  if (sig.linkedin) lines.push('LinkedIn: ' + sig.linkedin);
  if (sig.disclaimer) { lines.push(''); lines.push(sig.disclaimer); }
  return '\n' + lines.join('\n');
}

// ── Shared helper: build plain + HTML content (used by Zoho service too) ──────
function buildRawEmailParts({ body, signatureHtml = '', signaturePlain = '', trackingId, baseUrl }) {
  const plainText = stripToPlainText(body) + (signaturePlain || '');

  const pixel = trackingId
    ? `<img src="${baseUrl}/track/${trackingId}" width="1" height="1" style="display:none" />`
    : '';

  let htmlBody;
  if (body.includes('<p') || body.includes('<h') || body.includes('<div')) {
    htmlBody = body;
  } else if (hasMarkdown(body)) {
    const converted = markdownToHtml(body);
    htmlBody = `<div style="max-width:640px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#2d2d2d;padding:24px 16px">${converted}</div>`;
  } else {
    htmlBody = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#2d2d2d">${body.replace(/\n/g, '<br>')}</div>`;
  }

  const fullHtml = `<html><body>${htmlBody}${signatureHtml}${pixel}</body></html>`;
  return { plainText, htmlBody: fullHtml };
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  getAuthedClient,
  sendEmail,
  fetchUnreadReplies,
  parseEmailBody,
  buildRawEmailParts,
  buildSignatureHtml,
  buildSignaturePlainText
};
