/* ============================================================
   Welltower Recruiter — Outbound Composed-Email Sender
   Shared by POST /api/email/send (immediate) and the queue
   processor (scheduled_send jobs) so threading, tracking and
   follow-up behaviour stay identical on both paths.
   ============================================================ */

const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const storage        = require('./storage');
const gmailService   = require('./gmail');
const zohoService    = require('./zoho');
const outlookService = require('./outlook');
const smtpService    = require('./smtp');
const { DATA_DIR }   = require('../config');

const JD_ATTACHMENTS_DIR = path.join(DATA_DIR, 'jd-attachments');
function ensureJdAttachmentsDir() {
  if (!fs.existsSync(JD_ATTACHMENTS_DIR)) fs.mkdirSync(JD_ATTACHMENTS_DIR, { recursive: true });
}
function jdAttachmentPath(id) {
  // id is always a freshly generated uuidv4 (from the upload route) — never
  // user-supplied text — so this can't be used for path traversal.
  return path.join(JD_ATTACHMENTS_DIR, `${id}.docx`);
}

// Persist an uploaded "recruiter's edited version" DOCX to disk, keyed by a
// fresh id. Scheduled sends can be up to 30 days out, so this can't live
// only in request/response memory — it has to survive until send time.
function saveCustomAttachment(buffer) {
  ensureJdAttachmentsDir();
  const id = uuidv4();
  fs.writeFileSync(jdAttachmentPath(id), buffer);
  return id;
}

function deleteCustomAttachment(id) {
  if (!id) return;
  try { fs.unlinkSync(jdAttachmentPath(id)); } catch { /* already gone — fine */ }
}

// Periodic safety-net sweep for attachments uploaded but never sent (e.g. the
// recruiter closed the tab). Scheduled sends cap at 30 days out, so anything
// older than that is definitely orphaned.
function pruneOldCustomAttachments(maxAgeMs = 32 * 24 * 60 * 60 * 1000) {
  ensureJdAttachmentsDir();
  const cutoff = Date.now() - maxAgeMs;
  for (const f of fs.readdirSync(JD_ATTACHMENTS_DIR)) {
    const full = path.join(JD_ATTACHMENTS_DIR, f);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    } catch { /* race with another delete — fine */ }
  }
}

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
async function sendComposed(user, candidate, { subject, body, isReply = false, cc = null, isFollowUp = false, attachments = null }) {
  // Catches this before it reaches the provider API — otherwise a missing/
  // malformed address surfaces as a cryptic "Invalid To header" (Gmail's own
  // error text) instead of saying what's actually wrong. Covers every send
  // path (manual, scheduled, automated follow-ups) since they all funnel
  // through here.
  if (!candidate.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate.email.trim())) {
    throw new Error(`${candidate.name || 'This candidate'} doesn't have a valid email address on file.`);
  }

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
    ...(cc ? { cc } : {}),
    ...(attachments && attachments.length ? { attachments } : {})
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

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Build the role-JD DOCX attachment from structured variant data. Used by
// both the immediate-send route and the scheduled-send queue job (variants
// are stored as plain JSON on the job, and the document is rebuilt fresh at
// whichever point the send actually happens — a Buffer can't be persisted in
// the queue's JSON file). DOCX rather than PDF so a recruiter can open and
// edit the wording before it's attached to an outbound email.
async function buildRoleJDAttachment(candidate, user, roleJDVariants, jdLocation) {
  if (!roleJDVariants || !roleJDVariants.length) return null;
  const docxSvc = require('./docx');
  const company = (user.companyName || '').trim() || 'Confidential Role Overview';
  const buffer = await docxSvc.buildRoleJDDocx({
    companyName: company,
    candidateName: candidate.name || '',
    jdLocation: jdLocation || '',
    variants: roleJDVariants
  });
  const safeName = (candidate.name || 'Candidate').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'Candidate';
  return { filename: `Role Description - ${safeName}.docx`, content: buffer, contentType: DOCX_MIME };
}

// Single point of truth for "what attachment does this send carry", used by
// both the immediate /send route and the scheduled-send queue job so they
// can never drift: a recruiter's uploaded edit always wins over the
// AI-generated variants, whether the send happens now or days from now.
async function resolveRoleJDAttachment(candidate, user, { roleJDVariants, jdLocation, customAttachmentId, customAttachmentFilename } = {}) {
  if (customAttachmentId) {
    const filePath = jdAttachmentPath(customAttachmentId);
    if (!fs.existsSync(filePath)) {
      throw new Error('Your edited file could not be found — it may have expired. Please re-attach it.');
    }
    const content = fs.readFileSync(filePath);
    const safeName = (customAttachmentFilename || 'Role Description.docx').replace(/[\\/]/g, '_');
    return { filename: safeName, content, contentType: DOCX_MIME };
  }
  if (roleJDVariants && roleJDVariants.length) {
    return buildRoleJDAttachment(candidate, user, roleJDVariants, jdLocation);
  }
  return null;
}

module.exports = {
  sendComposed, getEmailService, isEmailConnected,
  isZohoOAuthReady, isOutlookReady, isSmtpReady,
  buildRoleJDAttachment, resolveRoleJDAttachment, DOCX_MIME,
  saveCustomAttachment, deleteCustomAttachment, pruneOldCustomAttachments
};
