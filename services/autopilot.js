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

// The next window-START instant strictly in the future, as real UTC millis.
// Used to reschedule a job the queue reached outside its send window: the old
// code pushed such jobs to *today's* start, which is in the past once the
// window has ended — so the job stayed perpetually "due", got re-checked,
// re-pushed to the same past time, and livelocked (0 sent, next-send time
// stuck in the past). Advancing to the next real future opening (skipping
// weekends when weekdaysOnly is set) lets the job actually fire when the
// window next opens instead of churning every tick.
function nextWindowStart(user, now, offsetHours) {
  const cfg = getConfig(user);
  for (let addDays = 0; addDays <= 7; addDays++) {
    const probe = new Date(now.getTime() + addDays * 86400000);
    const { startMs, dow } = windowBounds(cfg, probe, offsetHours);
    if (cfg.weekdaysOnly && (dow === 0 || dow === 6)) continue;
    if (startMs > now.getTime()) return startMs;
  }
  return now.getTime() + 60 * 60 * 1000; // safety fallback: one hour out
}

// Build today's [start,end] window as real UTC millis, given the sender's offset.
function windowBounds(cfg, now, offsetHours) {
  const local = new Date(now.getTime() + offsetHours * 3600 * 1000);
  const s = parseHM(cfg.windowStart), e = parseHM(cfg.windowEnd);
  const startLocal = new Date(local); startLocal.setUTCHours(s.h, s.m, 0, 0);
  const endLocal   = new Date(local); endLocal.setUTCHours(e.h, e.m, 0, 0);
  // If end is at/before start the window crosses midnight (e.g. 14:00→03:00):
  // treat the end as the following day so the window isn't a negative span.
  if (endLocal.getTime() <= startLocal.getTime()) {
    endLocal.setUTCDate(endLocal.getUTCDate() + 1);
  }
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

  // Eligible = imported, never contacted, has email, not bounced, not already queued.
  // Oldest imports first (FIFO).
  const eligible = candidates
    .filter(c => c.email
      && !c.bounced
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

/**
 * Explain the current autopilot state for the dashboard — returns a blocker
 * code + human message when nothing will send, or { ok:true } when healthy.
 * @param opts.emailConnected  whether the user has any email provider connected
 * @param opts.credits         current credit balance (cents)
 * @param opts.eligible        number of eligible (uncontacted) candidates
 */
function diagnose(user, { emailConnected, credits, eligible, now = new Date() } = {}) {
  const cfg = getConfig(user);
  if (!cfg.enabled)      return { ok: false, blocker: 'disabled',     message: 'Auto-outreach is turned off.' };
  if (!emailConnected)   return { ok: false, blocker: 'no_email',     message: 'No email account connected. Connect Gmail, Zoho, or Outlook in the Email tab — nothing can send until then.' };
  if ((credits || 0) <= 0) return { ok: false, blocker: 'no_credits', message: 'Out of credits. Auto-outreach is paused until your balance is topped up.' };

  const offset = scheduling.userOffset(user);
  const { startMs, endMs, dow } = windowBounds(cfg, now, offset);
  if (cfg.weekdaysOnly && (dow === 0 || dow === 6)) {
    return { ok: false, blocker: 'weekend', message: 'It\'s the weekend — weekdays-only is on, so sending resumes Monday.' };
  }
  if (!eligible || eligible <= 0) {
    return { ok: false, blocker: 'no_candidates', message: 'No uncontacted candidates left to email. Import more and they\'ll start going out automatically.' };
  }
  const t = now.getTime();
  if (t > endMs)  return { ok: true, blocker: null, message: 'Today\'s window has passed — sending resumes at the start of your next send window.' };
  if (t < startMs) return { ok: true, blocker: null, message: 'Waiting for today\'s send window to open.' };
  return { ok: true, blocker: null, message: 'Active and sending.' };
}

module.exports = { DEFAULTS, getConfig, effectiveCap, daysSinceStart, planDailyRun, diagnose, windowBounds, nextWindowStart };
