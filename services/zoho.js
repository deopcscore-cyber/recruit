/* ============================================================
   Welltower Recruiter — Zoho Mail Service (SMTP + IMAP)
   ============================================================ */

const nodemailer  = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { v4: uuidv4 } = require('uuid');
const storage = require('./storage');

// Re-use the shared signature + email body builders from gmail.js
// (they are provider-agnostic, just build HTML/plain content)
const {
  buildSignatureHtml,
  buildSignaturePlainText,
  buildRawEmailParts  // we'll export this lightweight helper from gmail.js
} = require('./gmail');

// ── SMTP transporter ──────────────────────────────────────────────────────────
function makeTransport(zoho) {
  return nodemailer.createTransport({
    host: 'smtp.zoho.com',
    port: 465,
    secure: true,           // SSL
    auth: { user: zoho.address, pass: zoho.appPassword },
    pool: false
  });
}

// ── Test credentials ──────────────────────────────────────────────────────────
async function testConnection(address, appPassword) {
  const transport = nodemailer.createTransport({
    host: 'smtp.zoho.com',
    port: 465,
    secure: true,
    auth: { user: address, pass: appPassword }
  });
  await transport.verify();
  transport.close();
}

// ── Send email ────────────────────────────────────────────────────────────────
async function sendEmail(userId, { to, subject, body, inReplyTo, references, trackingId }) {
  const user = await storage.getUserById(userId);
  if (!user) throw new Error('User not found');
  if (!user.zoho || !user.zoho.connected) throw new Error('Zoho Mail not connected');

  const signatureHtml  = buildSignatureHtml(user);
  const signaturePlain = buildSignaturePlainText(user);
  const { plainText, htmlBody } = buildRawEmailParts({ body, signatureHtml, signaturePlain, trackingId, baseUrl: require('../config').BASE_URL });

  const fromEmail = user.zoho.address;
  const fromName  = user.name || '';
  const from      = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;

  // Use a deterministic Message-ID we control so we can return it immediately
  const msgId = `<${uuidv4()}@recruit.welltower>`;

  const mailOpts = {
    from,
    to,
    subject,
    messageId: msgId,
    text: plainText,
    html: htmlBody,
    headers: {}
  };

  if (inReplyTo)  mailOpts.inReplyTo  = inReplyTo;
  if (references) mailOpts.references = references;

  const transport = makeTransport(user.zoho);
  await transport.sendMail(mailOpts);
  transport.close();

  return {
    gmailMessageId: null,
    gmailThreadId:  null,
    smtpMessageId:  msgId.replace(/^<|>$/g, '')
  };
}

// ── Fetch unread replies via IMAP ─────────────────────────────────────────────
async function fetchUnreadReplies(userId) {
  const user = await storage.getUserById(userId);
  if (!user) throw new Error('User not found');
  if (!user.zoho || !user.zoho.connected) throw new Error('Zoho Mail not connected');

  const client = new ImapFlow({
    host:   'imap.zoho.com',
    port:   993,
    secure: true,
    auth: { user: user.zoho.address, pass: user.zoho.appPassword },
    logger: false
  });

  await client.connect();
  const results = [];

  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Search for unseen messages from the last 30 days
      const since = new Date();
      since.setDate(since.getDate() - 30);

      const msgs = await client.search({ seen: false, since });
      if (!msgs || msgs.length === 0) return results;

      for await (const msg of client.fetch(msgs.slice(0, 50), {
        envelope: true,
        source: true,
        flags: true
      })) {
        try {
          const { simpleParser } = require('mailparser');
          const parsed = await simpleParser(msg.source);

          const fromAddr = parsed.from && parsed.from.value && parsed.from.value[0]
            ? parsed.from.value[0].address : '';
          const fromName = parsed.from && parsed.from.value && parsed.from.value[0]
            ? parsed.from.value[0].name : '';

          // Skip our own sent messages
          if (fromAddr.toLowerCase() === user.zoho.address.toLowerCase()) continue;

          results.push({
            from:           fromName ? `"${fromName}" <${fromAddr}>` : fromAddr,
            subject:        parsed.subject || '',
            body:           parsed.text   || parsed.html || '',
            gmailMessageId: `zoho-${msg.uid}`,
            gmailThreadId:  null,
            timestamp:      parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
            messageId:      (parsed.messageId || '').replace(/[<>]/g, ''),
            resumeAttachment: extractResumeAttachment(parsed)
          });

          // Mark as read
          await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']);
        } catch (e) {
          console.error('IMAP parse error:', e.message);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return results;
}

// ── Extract resume attachment from parsed email ───────────────────────────────
function extractResumeAttachment(parsed) {
  if (!parsed.attachments || !parsed.attachments.length) return null;
  const resumeTypes = ['application/pdf', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/rtf', 'text/rtf'];
  const att = parsed.attachments.find(a =>
    resumeTypes.includes(a.contentType) ||
    /\.(pdf|doc|docx|rtf)$/i.test(a.filename || '')
  );
  if (!att) return null;
  return { filename: att.filename || 'resume', mimeType: att.contentType, buffer: att.content };
}

// ── Scan Zoho Sent folder for prior contact (duplicate check) ─────────────────
async function getSentAddresses(userId) {
  const user = await storage.getUserById(userId);
  if (!user || !user.zoho || !user.zoho.connected) return [];

  const client = new ImapFlow({
    host:   'imap.zoho.com',
    port:   993,
    secure: true,
    auth: { user: user.zoho.address, pass: user.zoho.appPassword },
    logger: false
  });

  await client.connect();
  const addresses = new Set();

  try {
    // Zoho Sent folder — try common names
    let sentFolder = null;
    const list = await client.list();
    for (const box of list) {
      const name = (box.name || '').toLowerCase();
      if (name === 'sent' || name === 'sent items' || name === 'sent messages') {
        sentFolder = box.path; break;
      }
      if (box.specialUse === '\\Sent') { sentFolder = box.path; break; }
    }
    if (!sentFolder) return [];

    const lock = await client.getMailboxLock(sentFolder);
    try {
      const since = new Date();
      since.setFullYear(since.getFullYear() - 2);
      const msgs = await client.search({ since });

      for await (const msg of client.fetch(msgs.slice(0, 500), { envelope: true })) {
        const to = msg.envelope && msg.envelope.to ? msg.envelope.to : [];
        to.forEach(t => { if (t.address) addresses.add(t.address.toLowerCase()); });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return [...addresses];
}

module.exports = { testConnection, sendEmail, fetchUnreadReplies, getSentAddresses };
