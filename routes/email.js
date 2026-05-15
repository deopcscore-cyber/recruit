const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const gmailService = require('../services/gmail');
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
    if (!user.gmail || !user.gmail.connected) {
      return res.status(400).json({ error: 'Gmail not connected' });
    }

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

    const { gmailMessageId, gmailThreadId, smtpMessageId } = await gmailService.sendEmail(req.session.userId, sendParams);

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
    if (!user.gmail || !user.gmail.connected) {
      return res.status(400).json({ error: 'Gmail not connected' });
    }

    const replies = await gmailService.fetchUnreadReplies(req.session.userId);
    const candidates = await storage.getUserCandidates(req.session.userId);
    const updatedCandidates = [];

    for (const reply of replies) {
      // Extract email address from "From" header
      const fromEmail = extractEmail(reply.from);
      if (!fromEmail) continue;

      // Find matching candidate by email
      const candidate = candidates.find(c => c.email && c.email.toLowerCase() === fromEmail.toLowerCase());
      if (!candidate) continue;

      // Avoid adding duplicate messages
      const alreadyExists = (candidate.thread || []).some(
        t => t.gmailMessageId === reply.gmailMessageId
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
      candidates: updatedCandidates
    });
  } catch (err) {
    console.error('Fetch email error:', err);
    return res.status(500).json({ error: 'Failed to fetch emails: ' + err.message });
  }
});

// POST /api/email/test — send test email to self
router.post('/test', requireAuth, async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.gmail || !user.gmail.connected || !user.gmail.address) {
      return res.status(400).json({ error: 'Gmail not connected' });
    }

    const { gmailMessageId, gmailThreadId } = await gmailService.sendEmail(req.session.userId, {
      to: user.gmail.address,
      subject: 'Welltower Recruiter — Connection Test',
      body: `<p>Hello ${user.name},</p><p>Your Gmail connection is working correctly. You can now send emails through the Welltower Recruiter platform.</p><p>— Welltower Recruiter</p>`
    });

    return res.json({ success: true, gmailMessageId, gmailThreadId });
  } catch (err) {
    console.error('Test email error:', err);
    return res.status(500).json({ error: 'Test email failed: ' + err.message });
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
