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
    tls: { rejectUnauthorized: false, servername: cfg.host },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
}

// ─── Send via Resend HTTP API ─────────────────────────────────────────────────
// Shared platform Resend account (RESEND_API_KEY env var). Railway blocks
// outbound SMTP ports, so custom-domain sending routes over HTTPS instead.
// The consultant's domain must be verified in the Resend account.
async function sendViaResend({ from, to, cc, subject, html, text, inReplyTo, references }) {
  const axios = require('axios');
  const headers = {};
  if (inReplyTo)  headers['In-Reply-To'] = `<${inReplyTo.replace(/[<>]/g, '')}>`;
  if (references) headers['References']  = references;

  const payload = {
    from,
    to: [to],
    subject,
    html,
    text,
    ...(cc ? { cc: [cc] } : {}),
    ...(Object.keys(headers).length ? { headers } : {})
  };

  const res = await axios.post('https://api.resend.com/emails', payload, {
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 15000
  });
  return res.data?.id || uuidv4();
}

// ─── Send via SMTP (or Resend when configured) ────────────────────────────────
async function sendEmail(userId, { to, cc, subject, body, inReplyTo, references, trackingId }) {
  const user = await storage.getUserById(userId);
  if (!user?.smtp?.host) throw new Error('SMTP not configured');

  const cfg = user.smtp;
  const fromEmail = cfg.fromEmail || cfg.username;
  const fromName  = (cfg.fromName || user.name || '').trim();
  const from      = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;

  const sigHtml  = buildSignatureHtml(user);
  const sigPlain = buildSignaturePlainText(user);
  const { html, text } = buildRawEmailParts({ body, signatureHtml: sigHtml, signaturePlain: sigPlain, trackingId });

  // Prefer Resend when the platform key is set — Railway blocks raw SMTP
  if (process.env.RESEND_API_KEY) {
    try {
      const id = await sendViaResend({ from, to, cc, subject, html, text, inReplyTo, references });
      return { gmailMessageId: id, gmailThreadId: null, smtpMessageId: id };
    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data?.message || err.message;
      // 4xx = the API rejected us (bad key, unverified domain) — raw SMTP is
      // blocked on this host anyway, so surface the real error instead of
      // falling through to a confusing timeout
      if (status >= 400 && status < 500) {
        throw new Error('Email platform rejected the send: ' + detail);
      }
      console.warn('[Resend] send failed, falling back to raw SMTP:', detail);
    }
  }

  const resolvedHost = await resolveIPv4(cfg.host);
  const transporter = makeTransporter(cfg, resolvedHost);

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
  // With a platform Resend key, sending goes over HTTPS — validate the
  // sender's domain is verified in the Resend account instead of SMTP
  if (process.env.RESEND_API_KEY) {
    const axios = require('axios');
    const fromEmail = cfg.fromEmail || cfg.username;
    const domain = (fromEmail.split('@')[1] || '').toLowerCase();
    if (!domain) throw new Error('Invalid from email: ' + fromEmail);

    let res;
    try {
      res = await axios.get('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
        timeout: 10000
      });
    } catch (err) {
      const data = err.response?.data || {};
      const msg = data.message || err.message;
      // Sending-only keys can't list domains — that's fine, sending is all we need.
      // Domain verification will surface on the first real send if it's wrong.
      if (/restricted/i.test(data.name || '') || /restricted|only send/i.test(msg)) return;
      if (err.response?.status === 401) {
        throw new Error('Email platform API key is invalid — check the RESEND_API_KEY value (no extra spaces) and redeploy');
      }
      throw new Error('Email platform check failed: ' + msg);
    }

    const domains = res.data?.data || [];
    const match = domains.find(d => (d.name || '').toLowerCase() === domain);
    if (!match) {
      throw new Error(`The domain "${domain}" has not been added to the email platform yet — contact your administrator to add it`);
    }
    if (match.status !== 'verified') {
      throw new Error(`The domain "${domain}" is added but not verified yet (status: ${match.status}) — DNS records may still be propagating`);
    }
    return;
  }

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
