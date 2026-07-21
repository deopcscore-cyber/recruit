/* ============================================================
   Welltower Recruiter — Server-Side Bulk Email Queue
   Persists to DATA_DIR/bulk-queue.json so jobs survive
   browser closes and server restarts.
   ============================================================ */

const fs   = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');

const QUEUE_FILE = path.join(DATA_DIR, 'bulk-queue.json');
const TMP_FILE   = QUEUE_FILE + '.tmp';

function read() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  } catch { return []; }
}

function write(jobs) {
  try {
    fs.writeFileSync(TMP_FILE, JSON.stringify(jobs, null, 2));
    fs.renameSync(TMP_FILE, QUEUE_FILE);
  } catch (err) {
    console.error('Queue write error:', err.message);
  }
}

// Add new jobs (appends to existing queue)
function addJobs(jobs) {
  const queue = read();
  queue.push(...jobs);
  write(queue);
}

// All jobs belonging to a user
function getJobsForUser(userId) {
  return read().filter(j => j.userId === userId);
}

// Cancel all pending jobs for a user.
// Optionally restrict to a single type ('outreach' | 'followup') and/or a
// single source ('autopilot' vs. a manually-queued bulk batch) — so pausing
// autopilot doesn't also wipe out a recruiter's own manual bulk-send queue.
function cancelPendingForUser(userId, type = null, source = null) {
  const queue = read();
  let changed = false;
  queue.forEach(j => {
    if (j.userId === userId && j.status === 'pending'
      && (!type || (j.type || 'outreach') === type)
      && (!source || j.source === source)) {
      j.status = 'cancelled';
      changed = true;
    }
  });
  if (changed) write(queue);
}

// Cancel pending jobs for one candidate (used when they reply — stops follow-ups).
// Optionally restrict to a single follow-up kind ('roleJD', 'resumeRequested',
// etc.) so scheduling a new sequence doesn't clobber an unrelated one; omit to
// cancel every pending follow-up regardless of kind (e.g. on reply/bounce).
function cancelPendingForCandidate(candidateId, type = null, kind = null) {
  const queue = read();
  let changed = false;
  queue.forEach(j => {
    if (j.candidateId === candidateId && j.status === 'pending'
      && (!type || (j.type || 'outreach') === type)
      && (!kind || j.followUpKind === kind)) {
      j.status = 'cancelled';
      changed = true;
    }
  });
  if (changed) write(queue);
}

// Count pending follow-up jobs for a user (dashboard indicator).
function pendingFollowUpCount(userId) {
  return read().filter(j => j.userId === userId && j.status === 'pending' && (j.type || 'outreach') === 'followup').length;
}

// Next job that is pending AND whose scheduled time has passed
function getNextDueJob() {
  const now = new Date();
  return read().find(j => j.status === 'pending' && new Date(j.scheduledAt) <= now) || null;
}

// Patch a job by id
function updateJob(jobId, updates) {
  const queue = read();
  const job = queue.find(j => j.id === jobId);
  if (job) { Object.assign(job, updates); write(queue); }
}

// Advance all pending outreach jobs for a user to fire now,
// re-spacing them using the user's configured min/max spacing (with jitter).
// Jobs that would fall outside the send window are cancelled (they'll re-queue tomorrow).
function advancePendingNow(userId, minSpacingMin = 10, maxSpacingMin = 60, windowEnd = null) {
  const queue = read();
  const minMs = minSpacingMin * 60 * 1000;
  const maxMs = maxSpacingMin * 60 * 1000;
  let cursor = Date.now() + 60 * 1000; // first one in 1 minute
  let changed = false;
  queue
    .filter(j => j.userId === userId && j.status === 'pending' && (j.type || 'outreach') === 'outreach')
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))
    .forEach((j, i) => {
      if (i > 0) {
        const gap = minMs + Math.random() * (maxMs - minMs);
        cursor += gap;
      }
      // Cancel jobs that would go past the window end — autopilot will re-queue tomorrow
      if (windowEnd && cursor > windowEnd) {
        j.status = 'cancelled';
      } else {
        j.scheduledAt = new Date(cursor).toISOString();
      }
      changed = true;
    });
  if (changed) write(queue);
  return queue.filter(j => j.userId === userId && j.status === 'pending' && (j.type || 'outreach') === 'outreach').length;
}

// Reset jobs stuck in 'sending' back to pending. With no argument (boot), it
// resets every 'sending' job — nothing is legitimately in-flight right after a
// restart. With maxAgeMs (periodic sweep), it only resets jobs that entered
// 'sending' longer ago than that, so a job that's legitimately mid-send right
// now (a normal send is seconds) is never flipped back and re-sent.
function resetStuckJobs(maxAgeMs = null) {
  const queue = read();
  const now = Date.now();
  let changed = false;
  queue.forEach(j => {
    if (j.status !== 'sending') return;
    if (maxAgeMs != null) {
      const age = now - new Date(j.sendingAt || 0).getTime();
      if (age < maxAgeMs) return; // still plausibly in-flight — leave it
    }
    j.status = 'pending';
    changed = true;
  });
  if (changed) { write(queue); console.log('[Queue] Reset stuck "sending" jobs back to pending'); }
}

// Remove jobs older than 48 h that are done/failed/cancelled (keep pending)
function pruneOld() {
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const queue = read().filter(j =>
    j.status === 'pending' ||
    new Date(j.createdAt || j.scheduledAt).getTime() > cutoff
  );
  write(queue);
}

module.exports = {
  addJobs, getJobsForUser, cancelPendingForUser, cancelPendingForCandidate,
  pendingFollowUpCount, getNextDueJob, updateJob, pruneOld, resetStuckJobs, advancePendingNow
};
