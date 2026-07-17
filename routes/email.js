const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { google } = require('googleapis');
const gmailService   = require('../services/gmail');
const zohoService    = require('../services/zoho');
const outlookService = require('../services/outlook');
const smtpService    = require('../services/smtp');
const outbound       = require('../services/outbound');
const queueSvc       = require('../services/queue');

const { getEmailService, isEmailConnected, isZohoOAuthReady, isOutlookReady, isSmtpReady } = outbound;

// Gmail's own per-user quota — a transient condition that resolves itself,
// not a bug. Parses "User-rate limit exceeded. Retry after <ISO>" into the
// time the quota clears (15-min fallback when Google doesn't say).
function rateLimitRetryAt(err) {
  const msg = (err && err.message) || '';
  if (!/rate limit exceeded/i.test(msg)) return null;
  const match = msg.match(/Retry after (\S+)/i);
  const parsed = match ? new Date(match[1]) : null;
  if (parsed && !isNaN(parsed)) return parsed;
  return new Date(Date.now() + 15 * 60 * 1000);
}

function friendlyRateLimitError(err) {
  const retryAt = rateLimitRetryAt(err);
  if (!retryAt) return null;
  const minutes = Math.max(1, Math.ceil((retryAt - Date.now()) / 60000));
  return `Gmail is temporarily rate-limiting your account — this resolves on its own. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}
const storage = require('../services/storage');
const requireAuth = require('../middleware/auth');
const { DATA_DIR } = require('../config');

// GET /api/email/connect — generate OAuth URL
// state is a random nonce bound to this session; the callback verifies it and
// takes the user identity from the session, never from the state parameter.
router.get('/connect', requireAuth, async (req, res) => {
  try {
    const crypto = require('crypto');
    const state = crypto.randomBytes(24).toString('hex');
    req.session.oauthState = state;
    const url = gmailService.getAuthUrl(state);
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

    // Identity comes from the session; state must match the nonce we issued
    const userId = req.session && req.session.userId;
    if (!userId) {
      return res.redirect('/login?gmail=error&reason=session_expired');
    }
    if (!state || state !== req.session.oauthState) {
      return res.redirect('/dashboard?gmail=error&reason=state_mismatch');
    }
    delete req.session.oauthState;

    await gmailService.exchangeCode(userId, code);

    return res.redirect('/dashboard?gmail=connected');
  } catch (err) {
    console.error('Gmail callback error:', err);
    return res.redirect('/dashboard?gmail=error&reason=' + encodeURIComponent(err.message));
  }
};

// POST /api/email/send
router.post('/send', requireAuth, async (req, res) => {
  try {
    const { candidateId, subject, body, isReply, cc, scheduledAt, isFollowUp, roleJDVariants, jdLocation, customAttachmentId, customAttachmentFilename } = req.body;

    if (!candidateId || !subject || !body) {
      return res.status(400).json({ error: 'candidateId, subject, and body are required' });
    }

    const candidate = await storage.getCandidateById(candidateId);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
    if (candidate.userId !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });

    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!isEmailConnected(user)) {
      return res.status(400).json({ error: 'No email account connected. Connect Gmail, Zoho Mail, or Outlook in Settings.' });
    }

    // Schedule-send: queue the composed draft instead of sending immediately.
    // Times less than a minute out just send now — not worth a queue round-trip.
    if (scheduledAt) {
      const t = new Date(scheduledAt).getTime();
      if (isNaN(t)) return res.status(400).json({ error: 'Invalid scheduledAt timestamp' });
      if (t > Date.now() + 30 * 24 * 60 * 60 * 1000) {
        return res.status(400).json({ error: 'Scheduled time can be at most 30 days in the future' });
      }
      if (t > Date.now() + 60 * 1000) {
        const job = {
          id:            uuidv4(),
          type:          'scheduled_send',
          userId:        req.session.userId,
          candidateId:   candidate.id,
          candidateName: candidate.name,
          subject,
          body,
          isReply:       !!isReply,
          isFollowUp:    !!isFollowUp,
          cc:            cc || null,
          roleJDVariants: roleJDVariants || null,
          jdLocation:    jdLocation || '',
          customAttachmentId:       customAttachmentId || null,
          customAttachmentFilename: customAttachmentFilename || null,
          scheduledAt:   new Date(t).toISOString(),
          status:        'pending',
          createdAt:     new Date().toISOString()
        };
        queueSvc.addJobs([job]);
        return res.json({ scheduled: true, jobId: job.id, scheduledAt: job.scheduledAt });
      }
    }

    // Role JD sends carry either structured AI variant data or a recruiter's
    // uploaded edited DOCX — resolveRoleJDAttachment prefers the upload.
    let attachments = null;
    try {
      const att = await outbound.resolveRoleJDAttachment(candidate, user, { roleJDVariants, jdLocation, customAttachmentId, customAttachmentFilename });
      if (att) attachments = [att];
    } catch (attErr) {
      console.error('Role JD attachment build failed:', attErr.message);
      return res.status(500).json({ error: 'Failed to build the role description attachment: ' + attErr.message });
    }

    let sendResult;
    try {
      sendResult = await outbound.sendComposed(user, candidate, { subject, body, isReply: !!isReply, isFollowUp: !!isFollowUp, cc: cc || null, attachments });
      // An uploaded custom attachment is single-use once it's actually gone
      // out — the scheduled path cleans up separately since it may still be
      // pending.
      if (customAttachmentId) outbound.deleteCustomAttachment(customAttachmentId);
    } catch (sendErr) {
      // Gmail rate limit: instead of bouncing the user, queue this exact draft
      // to send automatically once the quota clears. Nothing was persisted —
      // sendComposed only saves state after a successful provider send.
      const retryAt = rateLimitRetryAt(sendErr);
      if (!retryAt) throw sendErr;

      // If this draft is already queued (user retried while rate-limited),
      // don't queue a duplicate — report the existing job instead.
      const existing = queueSvc.getJobsForUser(req.session.userId).find(j =>
        j.type === 'scheduled_send' && j.status === 'pending' &&
        j.candidateId === candidate.id && j.subject === subject && j.body === body);
      const job = existing || {
        id:            uuidv4(),
        type:          'scheduled_send',
        userId:        req.session.userId,
        candidateId:   candidate.id,
        candidateName: candidate.name,
        subject,
        body,
        isReply:       !!isReply,
        isFollowUp:    !!isFollowUp,
        cc:            cc || null,
        roleJDVariants: roleJDVariants || null,
        jdLocation:    jdLocation || '',
        customAttachmentId:       customAttachmentId || null,
        customAttachmentFilename: customAttachmentFilename || null,
        // small buffer past the reported reset so the retry doesn't hit the same window
        scheduledAt:   new Date(retryAt.getTime() + 90 * 1000).toISOString(),
        status:        'pending',
        createdAt:     new Date().toISOString(),
        reason:        'gmail_rate_limit'
      };
      if (!existing) queueSvc.addJobs([job]);
      const minutes = Math.max(1, Math.ceil((new Date(job.scheduledAt) - Date.now()) / 60000));
      return res.json({
        scheduled: true,
        rateLimited: true,
        jobId: job.id,
        scheduledAt: job.scheduledAt,
        message: `Gmail is rate-limiting your account, so this email was queued instead — it will send automatically in about ${minutes} minute${minutes === 1 ? '' : 's'}.`
      });
    }

    const { gmailMessageId, gmailThreadId } = sendResult;
    return res.json({ success: true, gmailMessageId, gmailThreadId, candidate });
  } catch (err) {
    console.error('Send email error:', err);
    if (err.message && err.message.startsWith('GMAIL_REAUTH_REQUIRED')) {
      return res.status(400).json({ error: err.message, reauth: 'gmail' });
    }
    const rateLimitMsg = friendlyRateLimitError(err);
    if (rateLimitMsg) {
      return res.status(429).json({ error: rateLimitMsg, rateLimited: true });
    }
    return res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

// POST /api/email/role-jd-download — render the role-JD as a DOCX on demand
// so the recruiter can open it in Word, review it, and edit the wording
// before it's attached to an outbound email. Variants are already generated
// client-side (from a prior /api/ai/role-jd call) — this just builds the
// document bytes; no AI call, no credits, no send. Unlike a PDF, a browser
// can't render this inline, so the response is a real download.
router.post('/role-jd-download', requireAuth, async (req, res) => {
  try {
    const { candidateId, roleJDVariants, jdLocation, customAttachmentId, customAttachmentFilename } = req.body;
    if (!candidateId || (!(roleJDVariants && roleJDVariants.length) && !customAttachmentId)) {
      return res.status(400).json({ error: 'candidateId and roleJDVariants (or customAttachmentId) are required' });
    }
    const candidate = await storage.getCandidateById(candidateId);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
    if (candidate.userId !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });

    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const attachment = await outbound.resolveRoleJDAttachment(candidate, user, { roleJDVariants, jdLocation, customAttachmentId, customAttachmentFilename });
    if (!attachment) return res.status(400).json({ error: 'No role description to download' });

    res.set({
      'Content-Type': attachment.contentType,
      'Content-Disposition': `attachment; filename="${attachment.filename.replace(/"/g, '')}"`,
      'Cache-Control': 'no-store'
    });
    return res.send(attachment.content);
  } catch (err) {
    console.error('Role JD download error:', err);
    return res.status(500).json({ error: 'Failed to build the role description document: ' + err.message });
  }
});

// Multer setup for the recruiter's edited role-JD upload — memory storage,
// the route persists it to disk itself via outbound.saveCustomAttachment
// (needs to be retrievable at send time, possibly days later for a
// scheduled send, so a plain in-request buffer isn't enough).
const jdAttachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.docx') return cb(null, true);
    cb(new Error('Only .docx files are accepted'));
  }
});

// POST /api/email/role-jd-attachment-upload — recruiter uploads their edited
// version of the role description. Stored on disk (not just in the request)
// because a scheduled send referencing it can fire days later.
router.post('/role-jd-attachment-upload', requireAuth, (req, res) => {
  jdAttachmentUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      const { candidateId } = req.body;
      if (!candidateId) return res.status(400).json({ error: 'candidateId is required' });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const candidate = await storage.getCandidateById(candidateId);
      if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
      if (candidate.userId !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });

      const attachmentId = outbound.saveCustomAttachment(req.file.buffer);
      return res.json({ attachmentId, filename: req.file.originalname });
    } catch (uploadErr) {
      console.error('Role JD attachment upload error:', uploadErr);
      return res.status(500).json({ error: 'Failed to save the uploaded file: ' + uploadErr.message });
    }
  });
});

// GET /api/email/scheduled/:candidateId — pending scheduled sends for one candidate
router.get('/scheduled/:candidateId', requireAuth, (req, res) => {
  try {
    const jobs = queueSvc.getJobsForUser(req.session.userId)
      .filter(j => j.type === 'scheduled_send' && j.status === 'pending' && j.candidateId === req.params.candidateId)
      .map(j => ({
        id: j.id, subject: j.subject, body: j.body, cc: j.cc, isReply: j.isReply, scheduledAt: j.scheduledAt,
        roleJDVariants: j.roleJDVariants || null, jdLocation: j.jdLocation || '',
        customAttachmentId: j.customAttachmentId || null, customAttachmentFilename: j.customAttachmentFilename || null
      }));
    return res.json({ jobs });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/email/scheduled/:jobId — cancel a pending scheduled send
router.delete('/scheduled/:jobId', requireAuth, (req, res) => {
  try {
    const job = queueSvc.getJobsForUser(req.session.userId).find(j => j.id === req.params.jobId);
    if (!job || job.type !== 'scheduled_send') return res.status(404).json({ error: 'Scheduled send not found' });
    if (job.status !== 'pending') return res.status(400).json({ error: `Cannot cancel — already ${job.status}` });
    // The candidate's edited file isn't reused by anything else once its job
    // is gone — clean it up rather than leaving it for the periodic sweep.
    if (job.customAttachmentId) outbound.deleteCustomAttachment(job.customAttachmentId);
    queueSvc.updateJob(job.id, { status: 'cancelled' });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
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
    // threadId -> candidateId map so gmail service can match by thread directly
    const candidateThreadIds = {};
    for (const c of candidates) {
      if (c.gmailThreadId) candidateThreadIds[c.gmailThreadId] = c.id;
    }
    const emailSvc = getEmailService(user);
    const replies = await emailSvc.fetchUnreadReplies(req.session.userId, candidateEmails, candidateThreadIds);
    const updatedCandidates = [];
    const newUnknownLeads = [];

    for (const reply of replies) {
      // Match candidate: prefer direct thread ID match, fall back to email address
      let candidate = null;
      if (reply.matchedCandidateId) {
        candidate = candidates.find(c => c.id === reply.matchedCandidateId);
      }
      if (!candidate) {
        const fromEmail = extractEmail(reply.from);
        if (fromEmail) {
          candidate = candidates.find(c => c.email && c.email.toLowerCase() === fromEmail.toLowerCase());
        }
      }
      // Fallback: scan reply body for tracking pixel URL — catches replies from a different address
      if (!candidate && reply.body) {
        candidate = candidates.find(c => c.trackingId && reply.body.includes(`/track/${c.trackingId}`));
      }
      if (!candidate) {
        // Only collect unknown leads for career consultants — recruiters don't receive inbound cold email
        if (reply.matched === false && user.userType === 'career_consultant') {
          const fromAddr2 = extractEmail(reply.from);
          if (fromAddr2) {
            newUnknownLeads.push({
              id: uuidv4(),
              from: reply.from || '',
              fromEmail: fromAddr2,
              fromName: reply.fromName || extractName(reply.from),
              subject: reply.subject || '',
              bodyPreview: reply.bodyPreview || (reply.body || '').replace(/\s+/g, ' ').slice(0, 160),
              timestamp: reply.timestamp || new Date().toISOString(),
              messageId: reply.messageId || reply.gmailMessageId || ''
            });
          }
        }
        continue;
      }

      // Bounce detection — sender is MAILER-DAEMON/postmaster, or subject signals NDR
      const fromAddr = (reply.from || '').toLowerCase();
      const subj     = (reply.subject || '').toLowerCase();
      const isBounce = /mailer-daemon|postmaster@|mail delivery subsystem|delivery subsystem/i.test(fromAddr)
        || /undeliverable|delivery (has )?fail|delivery status notification|returned mail|address not found|user unknown|no such user/i.test(subj);
      if (isBounce) {
        candidate.bounced   = true;
        candidate.bouncedAt = new Date().toISOString();
        await storage.saveCandidate(candidate);
        try { require('../services/followups').cancelSequence(candidate.id); } catch (e) {}
        console.log(`Bounce detected for ${candidate.name} <${candidate.email}> — follow-ups cancelled`);
        continue;
      }

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

      // They replied — stop the automated follow-up sequence
      try { require('../services/followups').cancelSequence(candidate.id); } catch (e) {}

      // Classify reply sentiment for inbox triage
      try {
        const claude = require('../services/claude');
        const sent = await claude.classifyReply(candidate, reply.body, user);
        if (sent && sent.label) {
          candidate.replySentiment = sent.label;
          candidate.replySentimentAt = new Date().toISOString();
          if (sent.costCents) {
            user.credits    = Math.max(0, (user.credits    || 0) - sent.costCents);
            user.totalSpent = (user.totalSpent || 0) + sent.costCents;
            await storage.saveUser(user);
          }
          if (sent.label === 'not_interested') {
            candidate.stage = 'Closed';
            candidate.closedReason = 'Declined (auto-detected)';
          }
        }
      } catch (clsErr) { console.error('Reply classify error:', clsErr.message); }

      // Update thread ID if not set
      if (!candidate.gmailThreadId && reply.gmailThreadId) {
        candidate.gmailThreadId = reply.gmailThreadId;
      }

      await storage.saveCandidate(candidate);
      updatedCandidates.push(candidate);
    }

    // Merge new unknown leads (dedup by messageId / fromEmail+subject,
    // and skip anything the user already dismissed — messages stay in the
    // inbox unmarked, so they resurface on every fetch otherwise)
    let unknownLeadsAdded = 0;
    if (newUnknownLeads.length > 0) {
      const existing = user.unknownLeads || [];
      const dismissed = new Set(user.dismissedLeadKeys || []);
      const existingIds = new Set(existing.map(l => l.messageId).filter(Boolean));
      const existingKeys = new Set(existing.map(l => `${(l.fromEmail || '').toLowerCase()}::${(l.subject || '').toLowerCase()}`));
      for (const lead of newUnknownLeads) {
        const key = `${(lead.fromEmail || '').toLowerCase()}::${(lead.subject || '').toLowerCase()}`;
        if (dismissed.has(lead.messageId) || dismissed.has(key)) continue;
        if (!existingIds.has(lead.messageId) && !existingKeys.has(key)) {
          existing.push(lead);
          unknownLeadsAdded++;
        }
      }
      user.unknownLeads = existing;
      await storage.saveUser(user);
    }

    return res.json({
      fetched: replies.length,
      matched: updatedCandidates.length,
      candidates: updatedCandidates,
      unknownLeads: unknownLeadsAdded,
      // debug info — shows raw fetched emails so we can diagnose matching failures
      debug: replies.map(r => ({ from: r.from, subject: r.subject, ts: r.timestamp }))
    });
  } catch (err) {
    console.error('Fetch email error:', err);
    return res.status(500).json({ error: 'Failed to fetch emails: ' + err.message });
  }
});

// POST /api/email/analyze-draft — instant, no-cost spam/deliverability lint of a draft
// Returns { score: 0-100, grade, issues: [...] }. Pure heuristics, no API call.
router.post('/analyze-draft', requireAuth, (req, res) => {
  try {
    const { subject = '', body = '' } = req.body || {};
    const issues = [];
    let score = 100;

    const text = `${subject}\n${body}`;
    const words = body.trim().split(/\s+/).filter(Boolean);

    // Spam-trigger phrases common in cold email filters
    const SPAM_WORDS = ['free', 'guarantee', 'guaranteed', 'act now', 'limited time', 'urgent', 'cash', 'winner', 'click here', 'buy now', 'risk-free', '100%', 'congratulations', 'no obligation', 'amazing', 'incredible offer', 'cheap', 'discount', 'earn money', 'income', 'investment', 'opportunity of a lifetime'];
    const found = SPAM_WORDS.filter(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
    if (found.length) { score -= Math.min(30, found.length * 8); issues.push({ level: 'warn', msg: `Spam-trigger word(s): ${found.slice(0,4).join(', ')}${found.length>4?'…':''}` }); }

    // Links — cold outreach with links hits spam more often
    const linkCount = (body.match(/https?:\/\/|www\./gi) || []).length;
    if (linkCount > 2) { score -= 15; issues.push({ level: 'warn', msg: `${linkCount} links — cut to 0–1 for cold outreach` }); }
    else if (linkCount > 0) { score -= 5; issues.push({ level: 'info', msg: `${linkCount} link — fine, but 0 is safest cold` }); }

    // Length
    if (words.length > 220) { score -= 12; issues.push({ level: 'warn', msg: `${words.length} words — long; aim under 180 for replies` }); }
    if (words.length < 30 && words.length > 0) { issues.push({ level: 'info', msg: `Very short (${words.length} words)` }); }

    // ALL CAPS words
    const capsWords = words.filter(w => w.length >= 4 && w === w.toUpperCase() && /[A-Z]/.test(w));
    if (capsWords.length >= 2) { score -= 10; issues.push({ level: 'warn', msg: `${capsWords.length} ALL-CAPS words read as shouting` }); }

    // Excessive punctuation
    if (/[!?]{2,}/.test(text) || (text.match(/!/g) || []).length > 2) { score -= 8; issues.push({ level: 'warn', msg: 'Too many exclamation marks' }); }

    // Subject checks
    if (!subject.trim()) { score -= 15; issues.push({ level: 'warn', msg: 'No subject line' }); }
    else if (subject.length > 60) { score -= 6; issues.push({ level: 'info', msg: `Subject ${subject.length} chars — trim under 50 for mobile` }); }
    if (/^(re:|fwd:)/i.test(subject) && !body) { /* fine */ }

    // Spammy subject patterns
    if (/\$|💰|free|!!/i.test(subject)) { score -= 10; issues.push({ level: 'warn', msg: 'Subject has spammy symbols/words' }); }

    score = Math.max(0, Math.min(100, score));
    const grade = score >= 85 ? 'Excellent' : score >= 70 ? 'Good' : score >= 50 ? 'Needs work' : 'High spam risk';
    if (!issues.length) issues.push({ level: 'ok', msg: 'Clean — no deliverability red flags' });

    return res.json({ score, grade, issues, words: words.length, links: linkCount });
  } catch (err) {
    return res.status(500).json({ error: 'Analysis failed' });
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
    const selfAddr   = (isZohoOAuthReady(user)) ? user.zoho.address : user.gmail.address;
    const selfLabel  = (isZohoOAuthReady(user)) ? 'Zoho (self)' : 'Gmail (self)';

    const recruiterName  = user.name  || 'Recruiter';
    const recruiterTitle = (user.title || 'Senior Talent Acquisition Coordinator').trim();
    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const testSubject = `Deliverability Check — ${ts}`;

    const companyName = (user.companyName || '').trim() || 'our company';
    const companyPitch = (user.companyPitch || '').trim() ||
      `I'm reaching out on behalf of ${companyName} — we're currently looking for experienced professionals who can make an impact at the leadership level.`;

    const testBody = `Dear Test Recipient,

Your career reflects something most professionals in this field never develop — a genuine combination of operational depth, strategic perspective, and direct experience built across multiple environments over time.

${companyPitch}

We're looking for professionals who understand what it takes to lead at this level — not just support from the outside. There is one part of what we are building right now that I kept out of this email on purpose — the kind of detail that is easier to show than describe. If any part of this caught your attention, reply here and I will send it over. No calls to schedule, no commitments — just a reply.

${recruiterName}
${recruiterTitle} at ${companyName}`;

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
    const selfAddr = (isZohoOAuthReady(user)) ? user.zoho.address : user.gmail.address;
    const provider = (isZohoOAuthReady(user)) ? 'Zoho Mail' : 'Gmail';

    await emailSvc.sendEmail(req.session.userId, {
      to: selfAddr,
      subject: 'Recruit Pro — Connection Test',
      body: `<p>Hello ${user.name},</p><p>Your ${provider} connection is working correctly. You can now send emails through the Recruit Pro platform.</p><p>— Recruit Pro</p>`
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
    if (isZohoOAuthReady(user)) {
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

function extractName(from) {
  if (!from) return '';
  const match = from.match(/^"?([^"<]+)"?\s*</);
  if (match) return match[1].trim();
  return '';
}

// GET /api/email/unknown-leads — return inbox leads not yet matched to any candidate
router.get('/unknown-leads', requireAuth, async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({ leads: user.unknownLeads || [] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/email/unknown-leads/:id — dismiss a lead (user ignored it or added as candidate)
router.delete('/unknown-leads/:id', requireAuth, async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const lead = (user.unknownLeads || []).find(l => l.id === req.params.id);
    user.unknownLeads = (user.unknownLeads || []).filter(l => l.id !== req.params.id);
    // Remember the dismissal so the same email doesn't resurface on the next fetch
    if (lead) {
      const key = lead.messageId || `${(lead.fromEmail || '').toLowerCase()}::${(lead.subject || '').toLowerCase()}`;
      user.dismissedLeadKeys = [...(user.dismissedLeadKeys || []), key].slice(-500);
    }
    await storage.saveUser(user);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/email/zoho-debug — probe all regions and URL formats to diagnose fetch issues
router.get('/zoho-debug', requireAuth, async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user || !user.zoho?.connected) return res.status(400).json({ error: 'Zoho not connected' });

    const axios = require('axios');
    const token = await zohoService.getAccessToken(user);
    const { accountId, apiBase, address } = user.zoho;

    const results = { accountId, storedApiBase: apiBase, address, regions: [] };

    // Step 1: get folders (globally routed — works anywhere)
    const foldersRes = await axios.get(`${apiBase}/accounts/${accountId}/folders`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });
    const folders = foldersRes.data.data || [];
    results.folders = folders.map(f => ({ name: f.folderName, type: f.folderType, id: f.folderId || f.folderid }));
    const inbox = folders.find(f =>
      (f.folderName || '').toLowerCase() === 'inbox' || (f.folderType || '').toLowerCase() === 'inbox'
    );
    const folderId = inbox ? (inbox.folderId || inbox.folderid) : null;
    results.inboxFolderId = folderId;

    // Step 2: probe all regions with both URL formats
    const BASES = [
      'https://mail.zoho.com/api', 'https://mail.zoho.eu/api',
      'https://mail.zoho.in/api', 'https://mail.zoho.com.au/api', 'https://mail.zoho.jp/api'
    ];
    const formats = folderId ? [
      `{base}/accounts/${accountId}/messages/view?folderId=${folderId}&limit=1`,
      `{base}/accounts/${accountId}/messages?folderId=${folderId}&limit=1`,
      `{base}/accounts/${accountId}/folders/${folderId}/messages/view?limit=1`,
      `{base}/accounts/${accountId}/folders/${folderId}/messages?limit=1`
    ] : [];

    for (const base of BASES) {
      const regionResult = { base, urls: [] };
      for (const fmt of formats) {
        const url = fmt.replace('{base}', base);
        try {
          const r = await axios.get(url, {
            headers: { Authorization: `Zoho-oauthtoken ${token}` },
            timeout: 8000
          });
          regionResult.urls.push({ url, status: r.status, dataKeys: Object.keys(r.data || {}) });
        } catch (e) {
          regionResult.urls.push({ url, status: e.response?.status, error: JSON.stringify(e.response?.data) });
        }
      }
      results.regions.push(regionResult);
    }

    return res.json(results);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.gmailCallback = gmailCallback;
