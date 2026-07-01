const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { v4: uuidv4 } = require('uuid');
const dns = require('dns');
const storage = require('./storage');
const { buildRawEmailParts, buildSignatureHtml, buildSignaturePlainText } = require('./gmail');

// Resolve hostname to IPv4 — Railway can't route IPv6 outbound
async function resolveIPv4(hostname) {
  // Skip resolution if it's already an IP address
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return hostname;
  try {
    const addresses = await dns.promises.resolve4(hostname);
    return addresses[0];
  } catch {
    return hostname; // fall back to original hostname
  }
}

// ─── Transporter factory ──────────────────────────────────────────────────────
function makeTransporter(cfg, resolvedHost) {
  return nodemailer.createTransport({
    host: resolvedHost || cfg.host,
    port: cfg.port || 587,
    secure: cfg.port === 465 || cfg.secure === true,
    auth: { user: cfg.username, pass: cfg.password },
    tls: { rejectUnauthorized: false, servername: cfg.host }
  });
}

// ─── Send via SMTP ────────────────────────────────────────────────────────────
async function sendEmail(userId, { to, cc, subject, body, inReplyTo, references, trackingId }) {
  const user = await storage.getUserById(userId);
  if (!user?.smtp?.host) throw new Error('SMTP not configured');

  const cfg = user.smtp;
  const resolvedHost = await resolveIPv4(cfg.host);
  const transporter = makeTransporter(cfg, resolvedHost);

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
  const resolvedImapHost = await resolveIPv4(imapHost);

  const client = new ImapFlow({
    host: resolvedImapHost,
    port: imapPort,
    secure: imapPort === 993 || cfg.imapSecure !== false,
    auth: { user: cfg.username, pass: cfg.password },
    logger: false,
    tls: { rejectUnauthorized: false, servername: imapHost }
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
          const isMatched = emailSet.size === 0 || emailSet.has(fromAddr);

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
            fromEmail:          fromAddr,
            fromName:           parsed.from?.value?.[0]?.name || '',
            subject:            parsed.subject || '',
            body:               textBody,
            bodyPreview:        textBody.replace(/\s+/g, ' ').slice(0, 160),
            gmailMessageId:     messageId || String(msg.uid),
            gmailThreadId:      null,
            matchedCandidateId: null,
            timestamp:          parsed.date?.toISOString() || new Date().toISOString(),
            messageId,
            resumeAttachment,
            matched:            isMatched
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
  const resolvedHost = await resolveIPv4(cfg.host);
  const transporter = makeTransporter(cfg, resolvedHost);
  await transporter.verify();
}

async function testImap(cfg) {
  const imapHost = cfg.imapHost || cfg.host;
  const imapPort = cfg.imapPort || 993;
  const resolvedImapHost = await resolveIPv4(imapHost);
  const client = new ImapFlow({
    host: resolvedImapHost,
    port: imapPort,
    secure: imapPort === 993 || cfg.imapSecure !== false,
    auth: { user: cfg.username, pass: cfg.password },
    logger: false,
    tls: { rejectUnauthorized: false, servername: imapHost }
  });
  await client.connect();
  await client.logout();
}

module.exports = { sendEmail, fetchUnreadReplies, testSmtp, testImap };
