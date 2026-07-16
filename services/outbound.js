/* ============================================================
   Welltower Recruiter — Outbound Composed-Email Sender
   Shared by POST /api/email/send (immediate) and the queue
   processor (scheduled_send jobs) so threading, tracking and
   follow-up behaviour stay identical on both paths.
   ============================================================ */

const { v4: uuidv4 } = require('uuid');
const storage        = require('./storage');
const gmailService   = require('./gmail');
const zohoService    = require('./zoho');
const outlookService = require('./outlook');
const smtpService    = require('./smtp');

function isZohoOAuthReady(user) {
  return !!(user.zoho?.connected && user.zoho.accessToken);
}
function isOutlookReady(user) {
  return !!(user.outlook?.connected && user.outlook.accessToken);
}
function isSmtpReady(user) {
  return !!(user.smtp?.connected && user.smtp.host && user.smtp.username && user.smtp.password);
}
function getEmailService(user) {
  if (isOutlookReady(user)) return outlookService;
  if (isZohoOAuthReady(user))  return zohoService;
  if (isSmtpReady(user))    return smtpService;
  return gmailService;
}
function isEmailConnected(user) {
  return !!(user.gmail?.connected) || isZohoOAuthReady(user) || isOutlookReady(user) || isSmtpReady(user);
}

// Send a user-composed email to a candidate: tracking pixel, reply threading,
// thread persistence, follow-up sequencing, and CC-mirroring.
// Mutates and saves the candidate; returns { gmailMessageId, gmailThreadId, candidate }.
async function sendComposed(user, candidate, { subject, body, isReply = false, cc = null, isFollowUp = false }) {
  // Fresh tracking pixel for every outbound email — resets the opened badge
  candidate.trackingId = uuidv4();
  candidate.opened     = false;
  candidate.openedAt   = null;
  // Any real send clears a stale pending draft — whether they used it as-is
  // or wrote something else entirely, its job is done either way.
  candidate.pendingFollowUpDraft = null;

  const sendParams = {
    to: candidate.email,
    subject,
    body,
    trackingId: candidate.trackingId,
    ...(cc ? { cc } : {})
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
  const { gmailMessageId, gmailThreadId, smtpMessageId } = await emailSvc.sendEmail(user.id, sendParams);

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
    read: true,
    ...(isFollowUp ? { isFollowUp: true } : {})
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

  // Automated follow-up sequence: schedule on a fresh outreach, cancel when
  // this send is a manual reply (the conversation is already moving).
  try {
    const followups = require('./followups');
    if (isReply) {
      followups.cancelSequence(candidate.id);
    } else {
      followups.scheduleSequence(user, candidate);
    }
  } catch (fuErr) {
    console.error('Follow-up scheduling error:', fuErr.message);
  }

  // ── CC-to-auto-appear: if email CC's a consultant user, mirror candidate to their account ──
  if (cc) {
    try {
      const ccEmail = cc.trim().toLowerCase();
      const consultantUser = await storage.getUserByEmail(ccEmail);
      if (consultantUser && consultantUser.id !== user.id) {
        const existing = await storage.getUserCandidates(consultantUser.id);
        const alreadyThere = existing.some(x =>
          (x.email || '').toLowerCase() === (candidate.email || '').toLowerCase() ||
          x.referredFromId === candidate.id
        );
        if (!alreadyThere) {
          const mirror = {
            id: uuidv4(),
            userId: consultantUser.id,
            name: candidate.name,
            email: candidate.email,
            title: candidate.title,
            company: candidate.company,
            location: candidate.location,
            summary: candidate.summary,
            background: candidate.background,
            career: candidate.career || [],
            education: candidate.education || [],
            linkedin: candidate.linkedin || '',
            resume: candidate.resume || null,
            stage: 'Imported',
            stepsCompleted: { introduced: true },
            consultantPipeline: true,
            referredFromId: candidate.id,
            referredBy: {
              userId: user.id,
              name: user.name || '',
              email: user.email || '',
              company: user.companyName || ''
            },
            thread: [{
              id: uuidv4(),
              direction: 'context',
              subject: subject,
              body: `[Referred by ${user.name || user.email}]\n\n${body}`,
              timestamp: new Date().toISOString(),
              read: true,
              isIntroContext: true
            }],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          await storage.saveCandidate(mirror);
          console.log(`[CC] Mirrored ${candidate.name} → consultant ${consultantUser.email}`);
        }
      }
    } catch (ccErr) {
      console.error('[CC] Mirror failed:', ccErr.message);
    }
  }

  return { gmailMessageId, gmailThreadId, candidate };
}

module.exports = {
  sendComposed, getEmailService, isEmailConnected,
  isZohoOAuthReady, isOutlookReady, isSmtpReady
};
