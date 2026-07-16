/* ============================================================
   Recruit Pro — Automated Follow-Up Sequences
   Every pipeline touchpoint (outreach, Role JD sent, resume
   requested, review sent, Victory/consultant intro sent) can
   start its own follow-up sequence: schedule N steps, and if
   the candidate replies before a step fires, cancel it.

   Two modes per kind:
   - 'auto'  — the queue processor sends the follow-up itself,
               no human review (early/low-stakes touchpoints).
   - 'draft' — the queue processor generates the follow-up and
               saves it on the candidate as a pending draft for
               the recruiter to review and send (later/higher-
               stakes touchpoints, e.g. after a resume review or
               a consultant introduction).
   ============================================================ */

const { v4: uuidv4 } = require('uuid');
const queueSvc   = require('./queue');
const scheduling = require('./scheduling');

// Per-kind defaults. 'outreach' is the only kind the user can customise via
// Settings (followUpConfig.steps) — the others are scripted to a specific
// cadence/purpose per touchpoint and aren't user-configurable yet.
const KIND_DEFAULTS = {
  outreach:        { mode: 'auto',  steps: [{ days: 3 }, { days: 7 }] },
  roleJD:          { mode: 'auto',  steps: [{ days: 3 }, { days: 7 }] },
  resumeRequested: { mode: 'auto',  steps: [{ days: 3 }, { days: 7 }] },
  review:          { mode: 'draft', steps: [{ days: 3 }] },
  victory:         { mode: 'draft', steps: [{ days: 5 }] }
};

function getConfig(user, kind = 'outreach') {
  const cfg = (user && user.followUpConfig) || {};
  const enabled = cfg.enabled !== undefined ? !!cfg.enabled : true; // on by default
  const defaults = KIND_DEFAULTS[kind] || KIND_DEFAULTS.outreach;
  const steps = kind === 'outreach' && Array.isArray(cfg.steps) && cfg.steps.length
    ? cfg.steps
    : defaults.steps;
  return { enabled, steps, mode: defaults.mode };
}

/**
 * Schedule a follow-up sequence of the given kind, anchored to right now
 * (i.e. call this immediately after the triggering email is sent).
 *
 * sinceTimestamp is stamped onto every job in the sequence — at fire time,
 * the processor only cancels itself if the candidate replied AFTER this
 * point. This matters once sequences aren't just for the very first
 * outreach: every candidate past "Outreach Sent" has already replied at
 * least once by definition, so checking "have they ever replied" would
 * immediately cancel every later-stage sequence. Checking "replied since
 * THIS touchpoint" is the correct generalisation.
 */
function scheduleSequence(user, candidate, kind = 'outreach') {
  const { enabled, steps, mode } = getConfig(user, kind);
  if (!enabled) return 0;

  // Starting a new sequence supersedes ALL previously pending follow-ups,
  // not just this kind — otherwise a recruiter jumping straight to a later
  // step (e.g. sending the resume request before the JD sequence resolved)
  // leaves a stale earlier-stage touch queued alongside the new one.
  queueSvc.cancelPendingForCandidate(candidate.id, 'followup');

  const fallbackOffset = scheduling.userOffset(user);
  const locationText = `${candidate.location || ''} ${candidate.summary || ''}`;
  const now = new Date();
  const sinceTimestamp = now.toISOString();

  const jobs = steps.map((step, idx) => ({
    id:            uuidv4(),
    type:          'followup',
    followUpKind:  kind,
    mode,
    userId:        user.id,
    candidateId:   candidate.id,
    candidateName: candidate.name,
    followUpIndex: idx,
    totalSteps:    steps.length,
    sinceTimestamp,
    scheduledAt:   scheduling.followUpTime({ locationText, fallbackOffset, days: step.days, from: now }),
    status:        'pending',
    createdAt:     now.toISOString()
  }));

  if (jobs.length) queueSvc.addJobs(jobs);
  return jobs.length;
}

// Stop every pending follow-up sequence for a candidate, regardless of kind —
// used when they reply, bounce, or the candidate is closed.
function cancelSequence(candidateId) {
  queueSvc.cancelPendingForCandidate(candidateId, 'followup');
}

module.exports = { getConfig, scheduleSequence, cancelSequence, KIND_DEFAULTS };
