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
// Optionally restrict to a single type ('outreach' | 'followup').
function cancelPendingForUser(userId, type = null) {
  const queue = read();
  let changed = false;
  queue.forEach(j => {
    if (j.userId === userId && j.status === 'pending' && (!type || (j.type || 'outreach') === type)) {
      j.status = 'cancelled';
      changed = true;
    }
  });
  if (changed) write(queue);
}

// Cancel pending jobs for one candidate (used when they reply — stops follow-ups).
function cancelPendingForCandidate(candidateId, type = null) {
  const queue = read();
  let changed = false;
  queue.forEach(j => {
    if (j.candidateId === candidateId && j.status === 'pending' && (!type || (j.type || 'outreach') === type)) {
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
function advancePendingNow(userId, minSpacingMin = 10, maxSpacingMin = 60) {
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
        // random gap within configured range
        const gap = minMs + Math.random() * (maxMs - minMs);
        cursor += gap;
      }
      j.scheduledAt = new Date(cursor).toISOString();
      changed = true;
    });
  if (changed) write(queue);
  return queue.filter(j => j.userId === userId && j.status === 'pending' && (j.type || 'outreach') === 'outreach').length;
}

// On server start, reset any jobs that got stuck in 'sending' (server crashed mid-job)
function resetStuckJobs() {
  const queue = read();
  let changed = false;
  queue.forEach(j => {
    if (j.status === 'sending') { j.status = 'pending'; changed = true; }
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
