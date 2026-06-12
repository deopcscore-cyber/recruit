/* ============================================================
   Recruit Pro — Daily Auto-Outreach (Autopilot)
   Once per day, enqueues a capped, drip-spaced batch of fresh
   outreach to not-yet-contacted candidates — no user action.
   Reuses the existing queue engine (which personalises, sends,
   deducts credits and kicks off follow-up sequences).
   ============================================================ */

const { v4: uuidv4 } = require('uuid');
const queueSvc   = require('./queue');
const scheduling = require('./scheduling');

// Default config applied when a user enables autopilot without customising.
const DEFAULTS = {
  enabled:       false,
  dailyCap:      30,      // safe ceiling for cold Gmail
  windowStart:   '09:00', // sender-local business hours
  windowEnd:     '17:00',
  weekdaysOnly:  true,
  minSpacingMin: 20,
  maxSpacingMin: 60,
  warmup:        true     // ramp up over the first ~2 weeks
};

function getConfig(user) {
  return { ...DEFAULTS, ...(user && user.autopilot ? user.autopilot : {}) };
}

// Days the user has been running autopilot (for the warm-up ramp).
function daysSinceStart(cfg, now) {
  if (!cfg.startedAt) return 0;
  return Math.max(0, Math.floor((now.getTime() - new Date(cfg.startedAt).getTime()) / 86400000));
}

// Warm-up ramp: start at 10/day, +5 every 2 days, capped at the daily cap.
function effectiveCap(cfg, now) {
  if (!cfg.warmup) return cfg.dailyCap;
  const ramp = 10 + Math.floor(daysSinceStart(cfg, now) / 2) * 5;
  return Math.min(cfg.dailyCap, ramp);
}

function localDateStr(now, offsetHours) {
  const local = new Date(now.getTime() + offsetHours * 3600 * 1000);
  return local.toISOString().slice(0, 10); // YYYY-MM-DD in sender-local time
}

function parseHM(hm) {
  const [h, m] = String(hm || '09:00').split(':').map(Number);
  return { h: h || 0, m: m || 0 };
}

// Build today's [start,end] window as real UTC millis, given the sender's offset.
function windowBounds(cfg, now, offsetHours) {
  const local = new Date(now.getTime() + offsetHours * 3600 * 1000);
  const s = parseHM(cfg.windowStart), e = parseHM(cfg.windowEnd);
  const startLocal = new Date(local); startLocal.setUTCHours(s.h, s.m, 0, 0);
  const endLocal   = new Date(local); endLocal.setUTCHours(e.h, e.m, 0, 0);
  return {
    startMs: startLocal.getTime() - offsetHours * 3600 * 1000,
    endMs:   endLocal.getTime()   - offsetHours * 3600 * 1000,
    dow:     local.getUTCDay()
  };
}

/**
 * Decide whether to run for this user right now, and if so produce the queue
 * jobs to enqueue. Returns { ran: bool, jobs: [], reason, count } and mutates
 * cfg.lastRunDate so the caller can persist it.
 *
 * @param user       full user object
 * @param candidates the user's candidates
 * @param now        Date
 */
function planDailyRun(user, candidates, now = new Date()) {
  const cfg = getConfig(user);
  if (!cfg.enabled) return { ran: false, reason: 'disabled' };

  const offset = scheduling.userOffset(user);
  const today  = localDateStr(now, offset);

  // Once per day only
  if (cfg.lastRunDate === today) return { ran: false, reason: 'already_ran_today' };

  const { startMs, endMs, dow } = windowBounds(cfg, now, offset);
  if (cfg.weekdaysOnly && (dow === 0 || dow === 6)) return { ran: false, reason: 'weekend' };

  // Only act once we're inside (or just before the end of) today's window
  if (now.getTime() > endMs) return { ran: false, reason: 'after_window' };

  // Pending candidates already queued — don't double up
  const pendingIds = new Set(queueSvc.getJobsForUser(user.id)
    .filter(j => j.status === 'pending')
    .map(j => j.candidateId));

  // Eligible = imported, never contacted, has email, not already queued.
  // Oldest imports first (FIFO).
  const eligible = candidates
    .filter(c => c.email
      && (c.stage || 'Imported') === 'Imported'
      && !(c.stepsCompleted || {}).outreach
      && !(c.thread || []).some(m => m.direction === 'outbound')
      && !pendingIds.has(c.id))
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));

  if (eligible.length === 0) {
    cfg.lastRunDate = today;
    return { ran: true, jobs: [], count: 0, reason: 'no_eligible', lastRunDate: today };
  }

  const cap = effectiveCap(cfg, now);
  const batch = eligible.slice(0, cap);

  // Drip the batch across the remaining window. We aim to fit the whole cap by
  // spreading evenly, but never closer than the user's minimum spacing (the
  // "never look bursty" floor). If even the floor won't fit them all, we send
  // what fits and the rest waits for tomorrow.
  const windowStart = Math.max(now.getTime(), startMs);
  const remainingMs = Math.max(0, endMs - windowStart);
  const minGap = Math.max(1, cfg.minSpacingMin) * 60 * 1000;
  const maxGap = Math.max(cfg.minSpacingMin, cfg.maxSpacingMin) * 60 * 1000;
  // Even spacing to fit the cap, clamped into [minGap, maxGap]
  const evenGap = batch.length > 1 ? remainingMs / batch.length : maxGap;
  const baseGap = Math.min(maxGap, Math.max(minGap, evenGap));

  const jobs = [];
  let cursor = windowStart;
  for (let i = 0; i < batch.length; i++) {
    if (i > 0) {
      // ±30% jitter around the base gap so the cadence looks human
      const jitter = baseGap * (0.7 + Math.random() * 0.6);
      cursor += jitter;
    }
    // If we'd spill past the window end, stop — the rest waits for tomorrow.
    if (cursor > endMs) break;
    const c = batch[i];
    jobs.push({
      id:            uuidv4(),
      type:          'outreach',
      source:        'autopilot',
      userId:        user.id,
      candidateId:   c.id,
      candidateName: c.name,
      subject:       '',  // processor uses AI-generated subject
      scheduledAt:   new Date(cursor).toISOString(),
      status:        'pending',
      createdAt:     now.toISOString()
    });
  }

  cfg.lastRunDate = today;
  return { ran: true, jobs, count: jobs.length, lastRunDate: today, effectiveCap: cap, eligibleTotal: eligible.length };
}

module.exports = { DEFAULTS, getConfig, effectiveCap, daysSinceStart, planDailyRun };
