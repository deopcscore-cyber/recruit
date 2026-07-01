const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { v4: uuidv4 } = require('uuid');
const storage = require('./storage');
const { buildRawEmailParts, buildSignatureHtml, buildSignaturePlainText } = require('./gmail');

// ─── Transporter factory ──────────────────────────────────────────────────────
function makeTransporter(cfg) {
  return nodemailer.createTransporter({
    host: cfg.host,
    port: cfg.port || 587,
    secure: cfg.port === 465 || cfg.secure === true,
    auth: { user: cfg.username, pass: cfg.password },
    tls: { rejectUnauthorized: false }
  });
}

// ─── Send via SMTP ────────────────────────────────────────────────────────────
async function sendEmail(userId, { to, cc, subject, body, inReplyTo, references, trackingId }) {
  const user = await storage.getUserById(userId);
  if (!user?.smtp?.host) throw new Error('SMTP not configured');

  const cfg = user.smtp;
  const transporter = makeTransporter(cfg);

  const fromEmail = cfg.fromEmail || cfg.username;
  const fromName  = (cfg.fromName || user.name || '').trim();
  const from      = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;

  const sigHtml  = buildSignatureHtml(user);
  const sigPlain = buildSignaturePlainText(user);
  const { html, text } = buildRawEmailParts({ body, signatureHtml: sigHtml, signaturePlain: sigPlain, trackingId });

  const mail = {
    from,
    to,
    subject,
    text,
    html,
    ...(cc        ? { cc }                         : {}),
    ...(inReplyTo ? { inReplyTo: `<${inReplyTo.replace(/[<>]/g, '')}>` } : {}),
    ...(references? { references }                  : {})
  };

  const info = await transporter.sendMail(mail);
  const smtpMessageId = (info.messageId || uuidv4()).replace(/[<>]/g, '');

  return { gmailMessageId: smtpMessageId, gmailThreadId: null, smtpMessageId };
}

// ─── Fetch unread replies via IMAP ────────────────────────────────────────────
async function fetchUnreadReplies(userId, candidateEmails = []) {
  const user = await storage.getUserById(userId);
  if (!user?.smtp?.host) throw new Error('IMAP not configured');

  const cfg = user.smtp;
  const imapHost = cfg.imapHost || cfg.host;
  const imapPort = cfg.imapPort || 993;

  const client = new ImapFlow({
    host: imapHost,
    port: imapPort,
    secure: imapPort === 993 || cfg.imapSecure !== false,
    auth: { user: cfg.username, pass: cfg.password },
    logger: false,
    tls: { rejectUnauthorized: false }
  });

  const emailSet = new Set(candidateEmails.map(e => e.toLowerCase()));
  const results  = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Search for unseen messages in the last 60 days
      const since = new Date();
      since.setDate(since.getDate() - 60);
      const uids = await client.search({ seen: false, since }, { uid: true });
      if (!uids.length) return results;

      for await (const msg of client.fetch(uids, { source: true }, { uid: true })) {
        try {
          const parsed = await simpleParser(msg.source);
          const fromAddr = (parsed.from?.value?.[0]?.address || '').toLowerCase();

          // Skip if not from a known candidate (when we have a candidate list)
          if (emailSet.size > 0 && !emailSet.has(fromAddr)) continue;

          const textBody = parsed.text || '';
          const messageId = (parsed.messageId || '').replace(/[<>]/g, '');

          // Resume attachment detection
          let resumeAttachment = null;
          for (const att of parsed.attachments || []) {
            const name = (att.filename || '').toLowerCase();
            if (name.endsWith('.pdf') || name.endsWith('.docx')) {
              resumeAttachment = {
                filename: att.filename,
                mimeType: att.contentType || (name.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
                buffer: att.content
              };
              break;
            }
          }

          results.push({
            from:               parsed.from?.text || fromAddr,
            subject:            parsed.subject || '',
            body:               textBody,
            gmailMessageId:     messageId || String(msg.uid),
            gmailThreadId:      null,
            matchedCandidateId: null,
            timestamp:          parsed.date?.toISOString() || new Date().toISOString(),
            messageId,
            resumeAttachment
          });

          // Mark as seen
          await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen'], { uid: true });
        } catch (parseErr) {
          console.error('[IMAP] parse error:', parseErr.message);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  return results;
}

// ─── Test connections ─────────────────────────────────────────────────────────
async function testSmtp(cfg) {
  const transporter = makeTransporter(cfg);
  await transporter.verify();
}

async function testImap(cfg) {
  const imapHost = cfg.imapHost || cfg.host;
  const imapPort = cfg.imapPort || 993;
  const client = new ImapFlow({
    host: imapHost,
    port: imapPort,
    secure: imapPort === 993 || cfg.imapSecure !== false,
    auth: { user: cfg.username, pass: cfg.password },
    logger: false,
    tls: { rejectUnauthorized: false }
  });
  await client.connect();
  await client.logout();
}

module.exports = { sendEmail, fetchUnreadReplies, testSmtp, testImap };
