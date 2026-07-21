const express = require('express');
const router = express.Router();
const storage = require('../services/storage');
const requireAuth = require('../middleware/auth');
const scheduling = require('../services/scheduling');

router.use(requireAuth);

const STAGES = ['Imported','Outreach Sent','Replied','Resume Requested','Resume Received','Interviewing','Closed'];

// "Today" means since midnight in the recruiter's own timezone — not a
// rolling 24 hours back from right now. A rolling window quietly folds in
// late-yesterday-evening activity, which reads as inflated/wrong the moment
// someone checks "Today" mid-afternoon and sees more than they actually
// sent today. The other windows (7/30/90 days) stay rolling, which is the
// normal convention for those.
function startOfTodayFor(user, now) {
  const offset = scheduling.userOffset(user);
  const localMs = now.getTime() + offset * 3600000;
  const localMidnightMs = Math.floor(localMs / 86400000) * 86400000;
  return new Date(localMidnightMs - offset * 3600000);
}

// GET /api/analytics?days=N — days is optional; omit (or 'all') for all-time.
// Metrics split into two kinds:
//  - Period-scoped (contacted, replied, open rate, sentiment, avg days): only
//    counts candidates whose first outreach falls inside the window, and only
//    counts opens/sentiment that happened inside it too — this is what
//    actually changes when you pick Today / This Week / etc.
//  - Current-state (pipeline stage breakdown, follow-ups due, unread, queued
//    auto follow-ups): these describe right-now inbox/pipeline state, which
//    doesn't have a meaningful "as of last Tuesday" version without tracking
//    stage-change history (which the app doesn't do) — always current
//    regardless of the selected period, and labeled as such on the frontend.
router.get('/', async (req, res) => {
  try {
    const candidates = await storage.getUserCandidates(req.session.userId);
    const user = await storage.getUserById(req.session.userId);
    const now = new Date();

    const daysParam = req.query.days && req.query.days !== 'all' ? parseInt(req.query.days, 10) : null;
    const cutoff = !daysParam || daysParam <= 0
      ? null
      : daysParam === 1
        ? startOfTodayFor(user, now)
        : new Date(now.getTime() - daysParam * 86400000);

    const firstOutreach = c => (c.thread || []).find(m => m.direction === 'outbound') || null;

    // Cohort every period-scoped metric below is computed against: candidates
    // first contacted inside the window (or everyone, if no period given).
    const periodCandidates = cutoff
      ? candidates.filter(c => {
          const first = firstOutreach(c);
          return first && new Date(first.timestamp) >= cutoff;
        })
      : candidates;

    // Stage counts — always current, never period-filtered (see note above)
    const stageCounts = {};
    STAGES.forEach(s => { stageCounts[s] = 0; });
    candidates.forEach(c => { if (stageCounts[c.stage] !== undefined) stageCounts[c.stage]++; });

    // Contacted = anyone in the cohort past Imported
    const contacted = periodCandidates.filter(c => c.stage !== 'Imported').length;
    // Replied = Replied or beyond, among the cohort
    const repliedCount = periodCandidates.filter(c => ['Replied','Resume Requested','Resume Received','Interviewing','Closed'].includes(c.stage)).length;
    const responseRate = contacted > 0 ? Math.round((repliedCount / contacted) * 100) : 0;

    // Email open rate, among the cohort
    const withOutreach = periodCandidates.filter(c => (c.thread||[]).some(m => m.direction === 'outbound')).length;
    const opened = periodCandidates.filter(c => c.opened).length;
    const openRate = withOutreach > 0 ? Math.round((opened / withOutreach) * 100) : 0;

    // Follow-ups due: explicit overdue reminder OR stuck in active stage with no reminder set
    // (always current — see note above)
    const ACTIVE_STAGES = ['Outreach Sent', 'Replied', 'Resume Requested', 'Resume Received', 'Interviewing'];
    const followUpsDue = candidates.filter(c => {
      const stage = c.stage || 'Imported';
      if (stage === 'Closed' || stage === 'Imported') return false;
      if (c.followUpDate && new Date(c.followUpDate) <= now) return true;
      if (ACTIVE_STAGES.includes(stage) && !c.followUpDate) return true;
      return false;
    });

    // Unread — always current
    const unreadCount = candidates.filter(c => c.unread).length;

    // Reply sentiment breakdown (auto-classified inbox triage) — scoped to
    // classifications that happened inside the window when one is selected
    const sentimentCounts = { interested: 0, question: 0, not_now: 0, not_interested: 0 };
    candidates.forEach(c => {
      if (!c.replySentiment || sentimentCounts[c.replySentiment] === undefined) return;
      if (cutoff) {
        if (!c.replySentimentAt || new Date(c.replySentimentAt) < cutoff) return;
      }
      sentimentCounts[c.replySentiment]++;
    });

    // Pending automated follow-ups queued for this user — always current
    let pendingFollowUps = 0;
    try { pendingFollowUps = require('../services/queue').pendingFollowUpCount(req.session.userId); } catch (e) {}

    // Deliverability warning — only once there's enough volume in the
    // selected period to mean anything (a handful of sends with 0 opens is
    // normal noise, not a signal).
    let deliverabilityWarning = null;
    const MIN_SAMPLE = 20;
    if (withOutreach >= MIN_SAMPLE) {
      if (openRate < 25) {
        deliverabilityWarning = {
          type: 'open_rate',
          openRate,
          message: `Only ${openRate}% of your emails are being opened — that usually means they're landing in spam, not that people aren't interested. Worth checking your sending setup.`
        };
      } else if (responseRate < 5) {
        deliverabilityWarning = {
          type: 'reply_rate',
          openRate,
          responseRate,
          message: `Your emails are being opened (${openRate}%) but almost nobody is replying (${responseRate}%) — that points to the message itself, not deliverability.`
        };
      }
    }

    // Avg days active (from first outbound to now), among the cohort
    const activeTimes = periodCandidates
      .filter(c => c.thread && c.thread.length > 0 && !['Closed'].includes(c.stage))
      .map(c => {
        const first = firstOutreach(c);
        return first ? Math.floor((now - new Date(first.timestamp)) / 86400000) : 0;
      });
    const avgDays = activeTimes.length
      ? Math.round(activeTimes.reduce((a, b) => a + b, 0) / activeTimes.length)
      : 0;

    // Stage-to-stage conversion funnel — always current, all candidates
    const funnel = [];
    for (let i = 0; i < STAGES.length - 1; i++) {
      const from = STAGES[i];
      const fromCount = candidates.filter(c => {
        const idx = STAGES.indexOf(c.stage);
        return idx >= i;
      }).length;
      funnel.push({ from, count: fromCount });
    }

    return res.json({
      period: daysParam || 'all',
      total: periodCandidates.length,
      totalAllTime: candidates.length,
      stageCounts,
      contacted,
      repliedCount,
      responseRate,
      openRate,
      followUpsDue: followUpsDue.length,
      followUpCandidates: followUpsDue.map(c => ({ id: c.id, name: c.name, followUpDate: c.followUpDate, stage: c.stage })),
      unreadCount,
      avgDays,
      funnel,
      sentimentCounts,
      pendingFollowUps,
      deliverabilityWarning
    });
  } catch (err) {
    console.error('Analytics error:', err);
    return res.status(500).json({ error: 'Failed to get analytics' });
  }
});

// GET /api/analytics/subjects — open-rate leaderboard by outreach subject line.
// Helps users learn which subject styles get opened (lightweight A/B insight,
// computed from data already tracked — works retroactively).
router.get('/subjects', async (req, res) => {
  try {
    const candidates = await storage.getUserCandidates(req.session.userId);
    const user = await storage.getUserById(req.session.userId);
    const daysParam = req.query.days && req.query.days !== 'all' ? parseInt(req.query.days, 10) : null;
    const cutoff = !daysParam || daysParam <= 0
      ? null
      : daysParam === 1
        ? startOfTodayFor(user, new Date())
        : new Date(Date.now() - daysParam * 86400000);
    const bySubject = new Map(); // normalized subject → { subject, sent, opened }

    for (const c of candidates) {
      // The first outbound message's subject is the one that drove the open
      const firstOut = (c.thread || []).find(m => m.direction === 'outbound');
      if (!firstOut || !firstOut.subject) continue;
      if (cutoff && new Date(firstOut.timestamp) < cutoff) continue;
      // Normalize: strip leading Re:, trailing first-name personalization noise
      const key = firstOut.subject.replace(/^re:\s*/i, '').trim().toLowerCase();
      if (!key) continue;
      const rec = bySubject.get(key) || { subject: firstOut.subject.replace(/^re:\s*/i, '').trim(), sent: 0, opened: 0 };
      rec.sent++;
      if (c.opened) rec.opened++;
      bySubject.set(key, rec);
    }

    const rows = [...bySubject.values()]
      .map(r => ({ ...r, openRate: r.sent ? Math.round((r.opened / r.sent) * 100) : 0 }))
      .filter(r => r.sent >= 1)
      .sort((a, b) => b.openRate - a.openRate || b.sent - a.sent)
      .slice(0, 25);

    return res.json({ subjects: rows });
  } catch (err) {
    console.error('Subject analytics error:', err);
    return res.status(500).json({ error: 'Failed to get subject analytics' });
  }
});

// GET /api/analytics/followups — successful follow-ups sent per day.
// A message only ever lands in a candidate's thread after the send actually
// succeeds (both the automated 3/7-day sequence and manually-drafted
// follow-ups sent via the Thread tab are tagged isFollowUp: true), so
// counting thread entries is the same as counting successful sends —
// nothing failed/pending shows up here.
router.get('/followups', async (req, res) => {
  try {
    const candidates = await storage.getUserCandidates(req.session.userId);
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));

    const byDay = new Map(); // 'YYYY-MM-DD' -> count
    const today = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      byDay.set(d.toISOString().slice(0, 10), 0);
    }

    let total = 0;
    for (const c of candidates) {
      for (const m of c.thread || []) {
        if (m.direction !== 'outbound' || !m.isFollowUp || !m.timestamp) continue;
        const key = new Date(m.timestamp).toISOString().slice(0, 10);
        if (byDay.has(key)) {
          byDay.set(key, byDay.get(key) + 1);
          total++;
        }
      }
    }

    const series = [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));

    return res.json({ days, total, series });
  } catch (err) {
    console.error('Follow-up analytics error:', err);
    return res.status(500).json({ error: 'Failed to get follow-up analytics' });
  }
});

module.exports = router;
