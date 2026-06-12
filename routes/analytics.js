const express = require('express');
const router = express.Router();
const storage = require('../services/storage');
const requireAuth = require('../middleware/auth');

router.use(requireAuth);

const STAGES = ['Imported','Outreach Sent','Replied','Resume Requested','Resume Received','Interviewing','Closed'];

// GET /api/analytics
router.get('/', async (req, res) => {
  try {
    const candidates = await storage.getUserCandidates(req.session.userId);
    const now = new Date();

    // Stage counts
    const stageCounts = {};
    STAGES.forEach(s => { stageCounts[s] = 0; });
    candidates.forEach(c => { if (stageCounts[c.stage] !== undefined) stageCounts[c.stage]++; });

    // Contacted = anyone past Imported
    const contacted = candidates.filter(c => c.stage !== 'Imported').length;
    // Replied = Replied or beyond
    const repliedCount = candidates.filter(c => ['Replied','Resume Requested','Resume Received','Interviewing','Closed'].includes(c.stage)).length;
    const responseRate = contacted > 0 ? Math.round((repliedCount / contacted) * 100) : 0;

    // Email open rate
    const withOutreach = candidates.filter(c => (c.thread||[]).some(m => m.direction === 'outbound')).length;
    const opened = candidates.filter(c => c.opened).length;
    const openRate = withOutreach > 0 ? Math.round((opened / withOutreach) * 100) : 0;

    // Follow-ups due: explicit overdue reminder OR stuck in active stage with no reminder set
    const ACTIVE_STAGES = ['Outreach Sent', 'Replied', 'Resume Requested', 'Resume Received', 'Interviewing'];
    const followUpsDue = candidates.filter(c => {
      const stage = c.stage || 'Imported';
      if (stage === 'Closed' || stage === 'Imported') return false;
      if (c.followUpDate && new Date(c.followUpDate) <= now) return true;
      if (ACTIVE_STAGES.includes(stage) && !c.followUpDate) return true;
      return false;
    });

    // Unread
    const unreadCount = candidates.filter(c => c.unread).length;

    // Reply sentiment breakdown (auto-classified inbox triage)
    const sentimentCounts = { interested: 0, question: 0, not_now: 0, not_interested: 0 };
    candidates.forEach(c => {
      if (c.replySentiment && sentimentCounts[c.replySentiment] !== undefined) sentimentCounts[c.replySentiment]++;
    });

    // Pending automated follow-ups queued for this user
    let pendingFollowUps = 0;
    try { pendingFollowUps = require('../services/queue').pendingFollowUpCount(req.session.userId); } catch (e) {}

    // Avg days active (from first outbound to now, for active candidates)
    const activeTimes = candidates
      .filter(c => c.thread && c.thread.length > 0 && !['Closed'].includes(c.stage))
      .map(c => {
        const first = c.thread.find(m => m.direction === 'outbound');
        return first ? Math.floor((now - new Date(first.timestamp)) / 86400000) : 0;
      });
    const avgDays = activeTimes.length
      ? Math.round(activeTimes.reduce((a, b) => a + b, 0) / activeTimes.length)
      : 0;

    // Stage-to-stage conversion funnel
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
      total: candidates.length,
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
      pendingFollowUps
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
    const bySubject = new Map(); // normalized subject → { subject, sent, opened }

    for (const c of candidates) {
      // The first outbound message's subject is the one that drove the open
      const firstOut = (c.thread || []).find(m => m.direction === 'outbound');
      if (!firstOut || !firstOut.subject) continue;
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

module.exports = router;
