const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { google } = require('googleapis');
const gmailService = require('../services/gmail');
const zohoService  = require('../services/zoho');

// Pick the right email service based on which account is connected
function getEmailService(user) {
  if (user.zoho && user.zoho.connected) return zohoService;
  return gmailService;
}
function isEmailConnected(user) {
  return (user.gmail && user.gmail.connected) || (user.zoho && user.zoho.connected);
}
const storage = require('../services/storage');
const requireAuth = require('../middleware/auth');
const { DATA_DIR } = require('../config');

// GET /api/email/connect — generate OAuth URL
router.get('/connect', requireAuth, async (req, res) => {
  try {
    const url = gmailService.getAuthUrl(req.session.userId);
    return res.json({ url });
  } catch (err) {
    console.error('Gmail connect error:', err);
    return res.status(500).json({ error: 'Failed to generate OAuth URL' });
  }
});

// GET /auth/gmail/callback — exported for server.js to mount at root level
const gmailCallback = async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      console.error('Gmail OAuth error:', error);
      return res.redirect('/dashboard?gmail=error&reason=' + encodeURIComponent(error));
    }

    if (!code) {
      return res.redirect('/dashboard?gmail=error&reason=no_code');
    }

    // state contains userId
    const userId = state || (req.session && req.session.userId);
    if (!userId) {
      return res.redirect('/dashboard?gmail=error&reason=no_user');
    }

    await gmailService.exchangeCode(userId, code);

    // If this is a different user than logged in session, set session
    if (req.session && !req.session.userId) {
      req.session.userId = userId;
    }

    return res.redirect('/dashboard?gmail=connected');
  } catch (err) {
    console.error('Gmail callback error:', err);
    return res.redirect('/dashboard?gmail=error&reason=' + encodeURIComponent(err.message));
  }
};

// POST /api/email/send
router.post('/send', requireAuth, async (req, res) => {
  try {
    const { candidateId, subject, body, isReply } = req.body;

    if (!candidateId || !subject || !body) {
      return res.status(400).json({ error: 'candidateId, subject, and body are required' });
    }

    const candidate = await storage.getCandidateById(candidateId);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
    if (candidate.userId !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });

    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!isEmailConnected(user)) {
      return res.status(400).json({ error: 'No email account connected. Connect Gmail or Zoho Mail in Settings.' });
    }

    // Fresh tracking pixel for every outbound email — resets the opened badge
    candidate.trackingId = uuidv4();
    candidate.opened     = false;
    candidate.openedAt   = null;

    const sendParams = {
      to: candidate.email,
      subject,
      body,
      trackingId: candidate.trackingId
    };

    // Threading — pass threadId AND the correct SMTP Message-ID for In-Reply-To
    if (isReply && candidate.gmailThreadId) {
      sendParams.threadId = candidate.gmailThreadId;
    }
    // Use the SMTP Message-ID (not the Gmail API ID) for RFC-compliant threading
    if (isReply && candidate.lastSmtpMessageId) {
      sendParams.inReplyTo = candidate.lastSmtpMessageId;
    }

    // Normalize subject for reply threading (RFC 2822 compliance)
    let replySubject = subject;
    if (isReply) {
      if (!replySubject.match(/^re:\s*/i)) {
        replySubject = 'Re: ' + (candidate.originalSubject || replySubject).replace(/^re:\s*/i, '');
      }
      sendParams.subject = replySubject;

      // Build In-Reply-To using SMTP Message-ID
      if (candidate.lastSmtpMessageId) {
        const cleanId = candidate.lastSmtpMessageId.replace(/^<|>$/g, '');
        sendParams.inReplyTo = cleanId;
        // Cumulative References chain
        const newRef = `<${cleanId}>`;
        sendParams.references = candidate.gmailReferences
          ? (candidate.gmailReferences.includes(newRef) ? candidate.gmailReferences : `${candidate.gmailReferences} ${newRef}`)
          : newRef;
      }
    }

    const emailSvc = getEmailService(user);
    const { gmailMessageId, gmailThreadId, smtpMessageId } = await emailSvc.sendEmail(req.session.userId, sendParams);

    // Add to thread
    const message = {
      id: uuidv4(),
      direction: 'outbound',
      subject,
      body,
      timestamp: new Date().toISOString(),
      gmailMessageId,
      gmailThreadId,
      smtpMessageId,
      read: true
    };

    if (!candidate.thread) candidate.thread = [];
    candidate.thread.push(message);
    candidate.lastGmailMessageId = gmailMessageId;
    candidate.lastSmtpMessageId = smtpMessageId;
    candidate.lastSubject = subject;

    // Update gmailThreadId if this was the first send
    if (!candidate.gmailThreadId) {
      candidate.gmailThreadId = gmailThreadId;
    }

    // Set a 5-day follow-up reminder on first outbound email if not already set
    if (!candidate.followUpDate) {
      const followUp = new Date();
      followUp.setDate(followUp.getDate() + 5);
      candidate.followUpDate = followUp.toISOString();
    }

    // Track first email subject for consistent thread subject on all replies
    if (!candidate.originalSubject) {
      candidate.originalSubject = sendParams.subject || subject;
    }

    // Update cumulative References chain with this outbound message's SMTP ID
    if (smtpMessageId) {
      const newRef = `<${smtpMessageId.replace(/^<|>$/g, '')}>`;
      candidate.gmailReferences = candidate.gmailReferences
        ? `${candidate.gmailReferences} ${newRef}`
        : newRef;
      candidate.lastSmtpMessageId = smtpMessageId;
    }

    await storage.saveCandidate(candidate);

    return res.json({ success: true, gmailMessageId, gmailThreadId, candidate });
  } catch (err) {
    console.error('Send email error:', err);
    return res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

// POST /api/email/fetch — fetch unread replies and match to candidates
router.post('/fetch', requireAuth, async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!isEmailConnected(user)) {
      return res.status(400).json({ error: 'No email account connected' });
    }

    const candidates = await storage.getUserCandidates(req.session.userId);
    const candidateEmails = candidates.map(c => c.email).filter(Boolean);
    const emailSvc = getEmailService(user);
    const replies = await emailSvc.fetchUnreadReplies(req.session.userId, candidateEmails);
    const updatedCandidates = [];

    for (const reply of replies) {
      // Extract email address from "From" header
      const fromEmail = extractEmail(reply.from);
      if (!fromEmail) continue;

      // Find matching candidate by email
      const candidate = candidates.find(c => c.email && c.email.toLowerCase() === fromEmail.toLowerCase());
      if (!candidate) continue;

      // Avoid adding duplicate messages — match on message ID or SMTP ID
      const alreadyExists = (candidate.thread || []).some(t =>
        (reply.gmailMessageId && t.gmailMessageId === reply.gmailMessageId) ||
        (reply.messageId && t.smtpMessageId && t.smtpMessageId === reply.messageId)
      );
      if (alreadyExists) continue;

      const message = {
        id: uuidv4(),
        direction: 'inbound',
        subject: reply.subject || candidate.lastSubject || '',
        body: reply.body,
        timestamp: reply.timestamp,
        gmailMessageId: reply.gmailMessageId,
        gmailThreadId: reply.gmailThreadId,
        smtpMessageId: reply.messageId || '',
        read: false
      };

      if (!candidate.thread) candidate.thread = [];
      candidate.thread.push(message);
      candidate.unread = true;
      candidate.lastGmailMessageId = reply.gmailMessageId;
      // Store inbound SMTP Message-ID so next outbound reply threads correctly
      if (reply.messageId) {
        candidate.lastSmtpMessageId = reply.messageId;
        const newRef = `<${reply.messageId.replace(/^<|>$/g, '')}>`;
        candidate.gmailReferences = candidate.gmailReferences
          ? (candidate.gmailReferences.includes(newRef) ? candidate.gmailReferences : `${candidate.gmailReferences} ${newRef}`)
          : newRef;
      }

      // ── Resume attachment auto-capture ───────────────────────────────────
      if (reply.resumeAttachment) {
        try {
          const resumeDir = path.join(DATA_DIR, 'resumes');
          if (!fs.existsSync(resumeDir)) fs.mkdirSync(resumeDir, { recursive: true });

          const safeFilename = reply.resumeAttachment.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
          const storedFilename = `${candidate.id}_${Date.now()}_${safeFilename}`;
          const filePath = path.join(resumeDir, storedFilename);
          fs.writeFileSync(filePath, reply.resumeAttachment.buffer);

          // Extract text from the file
          let extractedText = '';
          const mime = reply.resumeAttachment.mimeType;
          if (mime.includes('pdf')) {
            const pdfParse = require('pdf-parse');
            const parsed = await pdfParse(reply.resumeAttachment.buffer);
            extractedText = parsed.text || '';
          } else if (mime.includes('word') || mime.includes('openxmlformats')) {
            const mammoth = require('mammoth');
            const res = await mammoth.extractRawText({ buffer: reply.resumeAttachment.buffer });
            extractedText = res.value || '';
          }

          candidate.resume = {
            filename: storedFilename,
            originalName: reply.resumeAttachment.filename,
            path: filePath,
            text: extractedText,
            mimetype: mime,
            size: reply.resumeAttachment.buffer.length,
            uploadedAt: new Date().toISOString(),
            source: 'email'
          };

          // Mark step complete + auto-advance stage to Resume Received
          if (!candidate.stepsCompleted) candidate.stepsCompleted = {};
          candidate.stepsCompleted.resumeReceived = true;

          const stageOrder2 = ['Imported','Outreach Sent','Replied','Resume Requested','Resume Received','Interviewing','Closed'];
          const curIdx2 = stageOrder2.indexOf(candidate.stage || 'Imported');
          const recvIdx = stageOrder2.indexOf('Resume Received');
          if (curIdx2 < recvIdx) candidate.stage = 'Resume Received';

          console.log(`Resume auto-captured from email for candidate ${candidate.name} (${storedFilename})`);
        } catch (attachErr) {
          console.error('Resume attachment processing error:', attachErr.message);
        }
      }
      // ────────────────────────────────────────────────────────────────────

      // Auto-advance stage to Replied (only upgrade, never downgrade)
      const stageOrder = ['Imported','Outreach Sent','Replied','Resume Requested','Resume Received','Interviewing','Closed'];
      const currentIdx = stageOrder.indexOf(candidate.stage || 'Imported');
      const repliedIdx = stageOrder.indexOf('Replied');
      if (currentIdx < repliedIdx) {
        candidate.stage = 'Replied';
      }

      // Clear the follow-up reminder since they replied
      candidate.followUpDate = null;

      // Update thread ID if not set
      if (!candidate.gmailThreadId && reply.gmailThreadId) {
        candidate.gmailThreadId = reply.gmailThreadId;
      }

      await storage.saveCandidate(candidate);
      updatedCandidates.push(candidate);
    }

    return res.json({
      fetched: replies.length,
      matched: updatedCandidates.length,
      candidates: updatedCandidates,
      // debug info — shows raw fetched emails so we can diagnose matching failures
      debug: replies.map(r => ({ from: r.from, subject: r.subject, ts: r.timestamp }))
    });
  } catch (err) {
    console.error('Fetch email error:', err);
    return res.status(500).json({ error: 'Failed to fetch emails: ' + err.message });
  }
});

// POST /api/email/deliverability-test — send realistic test email to self + optional secondary/mail-tester
router.post('/deliverability-test', requireAuth, async (req, res) => {
  try {
    const { includeSecondary, mailtesterAddress } = req.body || {};

    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!isEmailConnected(user)) {
      return res.status(400).json({ error: 'No email account connected' });
    }

    const emailSvc   = getEmailService(user);
    const selfAddr   = (user.zoho && user.zoho.connected) ? user.zoho.address : user.gmail.address;
    const selfLabel  = (user.zoho && user.zoho.connected) ? 'Zoho (self)' : 'Gmail (self)';

    const recruiterName  = user.name  || 'Recruiter';
    const recruiterTitle = (user.title || 'Senior Talent Acquisition Coordinator').trim();
    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const testSubject = `Deliverability Check — ${ts}`;

    const testBody = `Dear Test Recipient,

Your career in senior living leadership reflects something most professionals in this field never develop — a genuine combination of operational depth, strategic perspective, and direct care experience built across multiple environments over time.

I'm reaching out on behalf of Welltower Inc. (NYSE: WELL) — a company that operates at a truly unique intersection: healthcare and real estate. We own and manage a global portfolio of senior housing communities, post-acute care facilities, and outpatient medical properties, and the work we do shapes how millions of people experience care and community as they age.

We're looking for senior living professionals who understand what it takes to lead a care environment — not just support one from the outside — and who bring the hands-on operational knowledge that comes from having led one. There is one part of what we are building right now that I kept out of this email on purpose — the kind of detail that is easier to show than describe, and that I think lands differently once you see the full picture. If any part of this caught your attention, reply here and I will send it over. No calls to schedule, no commitments — just a reply.

${recruiterName}
${recruiterTitle} at Welltower™ Inc.`;

    // 1. Always send to own account (for inbox/spam check)
    const { gmailThreadId, gmailMessageId } = await emailSvc.sendEmail(
      req.session.userId,
      { to: selfAddr, subject: testSubject, body: testBody }
    );

    const sends = [{ to: selfAddr, label: selfLabel }];

    // 2. Secondary inbox (cross-provider check)
    if (includeSecondary && user.secondaryTestEmail) {
      try {
        await emailSvc.sendEmail(req.session.userId, {
          to: user.secondaryTestEmail, subject: testSubject, body: testBody
        });
        sends.push({ to: user.secondaryTestEmail, label: 'Secondary inbox' });
      } catch (e) {
        console.error('Secondary send failed:', e.message);
      }
    }

    // 3. Mail-Tester
    let mailtesterName = null;
    if (mailtesterAddress && mailtesterAddress.includes('@')) {
      try {
        await emailSvc.sendEmail(req.session.userId, {
          to: mailtesterAddress.trim(), subject: testSubject, body: testBody
        });
        mailtesterName = mailtesterAddress.trim().split('@')[0];
        sends.push({ to: mailtesterAddress, label: 'Mail-Tester' });
      } catch (e) {
        console.error('Mail-Tester send failed:', e.message);
      }
    }

    return res.json({
      threadId: gmailThreadId,
      messageId: gmailMessageId,
      sentAt: new Date().toISOString(),
      sends,
      mailtesterName
    });
  } catch (err) {
    console.error('Deliverability test error:', err);
    return res.status(500).json({ error: 'Failed to send test: ' + err.message });
  }
});

// GET /api/email/deliverability-result/:threadId — poll for inbox/spam result
router.get('/deliverability-result/:threadId', requireAuth, async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user?.gmail?.connected) return res.status(400).json({ error: 'Gmail not connected' });

    const auth  = await gmailService.getAuthedClient(user);
    const gmail = google.gmail({ version: 'v1', auth });

    const thread = await gmail.users.threads.get({
      userId: 'me',
      id: req.params.threadId,
      format: 'metadata',
      metadataHeaders: ['Subject']
    });

    const messages = thread.data.messages || [];

    // The received copy has INBOX or SPAM; the sent copy only has SENT
    let result = 'pending';
    const allLabels = [];
    for (const msg of messages) {
      const labels = msg.labelIds || [];
      allLabels.push(...labels);
      if (labels.includes('INBOX'))        { result = 'inbox'; break; }
      if (labels.includes('SPAM'))         { result = 'spam';  break; }
      if (labels.includes('CATEGORY_PROMOTIONS') || labels.includes('CATEGORY_UPDATES')) {
        result = 'tabs'; // landed in Gmail Promotions/Updates tab — not main inbox
        break;
      }
    }

    return res.json({ result, labels: [...new Set(allLabels)] });
  } catch (err) {
    console.error('Deliverability result error:', err);
    return res.status(500).json({ result: 'unknown', error: err.message });
  }
});

// POST /api/email/test — send test email to self
router.post('/test', requireAuth, async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!isEmailConnected(user)) {
      return res.status(400).json({ error: 'No email account connected' });
    }

    const emailSvc = getEmailService(user);
    const selfAddr = (user.zoho && user.zoho.connected) ? user.zoho.address : user.gmail.address;
    const provider = (user.zoho && user.zoho.connected) ? 'Zoho Mail' : 'Gmail';

    await emailSvc.sendEmail(req.session.userId, {
      to: selfAddr,
      subject: 'Welltower Recruiter — Connection Test',
      body: `<p>Hello ${user.name},</p><p>Your ${provider} connection is working correctly. You can now send emails through the Welltower Recruiter platform.</p><p>— Welltower Recruiter</p>`
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Test email error:', err);
    return res.status(500).json({ error: 'Test email failed: ' + err.message });
  }
});

// POST /api/email/check-prior-contact — scan sent folder for prior sends to given addresses
router.post('/check-prior-contact', requireAuth, async (req, res) => {
  try {
    const { emails } = req.body;
    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      return res.json({ contacted: [] });
    }

    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.json({ contacted: [] });

    const contacted = new Set();

    // ── Zoho path ────────────────────────────────────────────────────────────
    if (user.zoho && user.zoho.connected) {
      try {
        const allSent = await zohoService.getSentAddresses(req.session.userId);
        const emailSet = new Set(emails.map(e => e.toLowerCase().trim()));
        allSent.forEach(addr => { if (emailSet.has(addr)) contacted.add(addr); });
      } catch (e) {
        console.error('Zoho prior contact check error:', e.message);
      }
      return res.json({ contacted: [...contacted] });
    }

    // ── Gmail path ───────────────────────────────────────────────────────────
    if (!user.gmail || !user.gmail.connected) return res.json({ contacted: [] });

    const auth  = await gmailService.getAuthedClient(user);
    const gmail = google.gmail({ version: 'v1', auth });

    const BATCH = 15;
    for (let i = 0; i < emails.length; i += BATCH) {
      const batch = emails.slice(i, i + BATCH).map(e => e.toLowerCase().trim()).filter(Boolean);
      if (batch.length === 0) continue;

      const query = `in:sent (${batch.map(e => `to:${e}`).join(' OR ')})`;
      try {
        const listRes = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 20 });
        const messages = listRes.data.messages || [];
        if (messages.length === 0) continue;

        for (const msg of messages.slice(0, 8)) {
          try {
            const msgRes = await gmail.users.messages.get({
              userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['To']
            });
            const toHeader = (msgRes.data.payload?.headers || []).find(h => h.name.toLowerCase() === 'to');
            if (toHeader) {
              const found = toHeader.value.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
              found.forEach(e => contacted.add(e.toLowerCase()));
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }

    return res.json({ contacted: [...contacted] });
  } catch (err) {
    console.error('check-prior-contact error:', err);
    return res.json({ contacted: [] });
  }
});

// Helper: extract email from "Name <email@example.com>" or plain email
function extractEmail(from) {
  if (!from) return null;
  const match = from.match(/<([^>]+)>/);
  if (match) return match[1].trim();
  if (from.includes('@')) return from.trim();
  return null;
}

module.exports = router;
module.exports.gmailCallback = gmailCallback;
