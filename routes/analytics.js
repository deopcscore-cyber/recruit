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

    // Follow-ups due (overdue and not closed/interviewing)
    const followUpsDue = candidates.filter(c =>
      c.followUpDate && new Date(c.followUpDate) <= now &&
      !['Closed', 'Interviewing'].includes(c.stage)
    );

    // Unread
    const unreadCount = candidates.filter(c => c.unread).length;

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
      funnel
    });
  } catch (err) {
    console.error('Analytics error:', err);
    return res.status(500).json({ error: 'Failed to get analytics' });
  }
});

module.exports = router;
