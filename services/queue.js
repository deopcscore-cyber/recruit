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

// Cancel all pending jobs for a user
function cancelPendingForUser(userId) {
  const queue = read();
  let changed = false;
  queue.forEach(j => {
    if (j.userId === userId && j.status === 'pending') {
      j.status = 'cancelled';
      changed = true;
    }
  });
  if (changed) write(queue);
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

// Remove jobs older than 48 h that are done/failed/cancelled (keep pending)
function pruneOld() {
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const queue = read().filter(j =>
    j.status === 'pending' ||
    new Date(j.createdAt || j.scheduledAt).getTime() > cutoff
  );
  write(queue);
}

module.exports = { addJobs, getJobsForUser, cancelPendingForUser, getNextDueJob, updateJob, pruneOld };
