/* ============================================================
   Recruit Pro — Automated Follow-Up Sequences
   When an outreach is sent, schedule N follow-ups in the queue.
   When the candidate replies, those pending follow-ups are
   cancelled (handled at the reply-ingestion points).
   ============================================================ */

const { v4: uuidv4 } = require('uuid');
const queueSvc   = require('./queue');
const scheduling = require('./scheduling');

// Default cadence if the user hasn't customised one.
const DEFAULT_STEPS = [{ days: 3 }, { days: 7 }];

function getConfig(user) {
  const cfg = (user && user.followUpConfig) || {};
  return {
    enabled: cfg.enabled !== undefined ? !!cfg.enabled : true,  // on by default
    steps: Array.isArray(cfg.steps) && cfg.steps.length ? cfg.steps : DEFAULT_STEPS
  };
}

/**
 * Schedule the full follow-up sequence for a candidate after an outreach send.
 * Cancels any pre-existing pending follow-ups first (so re-sending outreach
 * resets the sequence rather than stacking duplicates).
 */
function scheduleSequence(user, candidate) {
  const cfg = getConfig(user);
  if (!cfg.enabled) return 0;

  queueSvc.cancelPendingForCandidate(candidate.id, 'followup');

  const fallbackOffset = scheduling.userOffset(user);
  const locationText = `${candidate.location || ''} ${candidate.summary || ''}`;
  const now = new Date();

  const jobs = cfg.steps.map((step, idx) => ({
    id:            uuidv4(),
    type:          'followup',
    userId:        user.id,
    candidateId:   candidate.id,
    candidateName: candidate.name,
    followUpIndex: idx,
    totalSteps:    cfg.steps.length,
    scheduledAt:   scheduling.followUpTime({ locationText, fallbackOffset, days: step.days, from: now }),
    status:        'pending',
    createdAt:     now.toISOString()
  }));

  if (jobs.length) queueSvc.addJobs(jobs);
  return jobs.length;
}

// Stop the sequence (candidate replied, was closed, etc.)
function cancelSequence(candidateId) {
  queueSvc.cancelPendingForCandidate(candidateId, 'followup');
}

module.exports = { getConfig, scheduleSequence, cancelSequence, DEFAULT_STEPS };
