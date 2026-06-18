const express    = require('express');
const router     = express.Router();
const { v4: uuidv4 } = require('uuid');
const requireAuth = require('../middleware/auth');
const queueSvc   = require('../services/queue');
const scheduling = require('../services/scheduling');
const storage    = require('../services/storage');

router.use(requireAuth);

function emailConnected(user) {
  return (user.gmail && user.gmail.connected) ||
    (user.zoho && user.zoho.connected && user.zoho.accessToken) ||
    (user.outlook && user.outlook.connected && user.outlook.accessToken);
}

// POST /api/queue/bulk-outreach
// Body: { candidateIds: [...], mode: 'optimal' | 'now', spacingMinutes?: number }
// One personalised-outreach job per candidate. The draft is generated
// per-candidate at send time by the queue processor (real personalisation,
// not a template). 'optimal' spreads sends into Tue–Thu 9am windows in each
// recipient's timezone; 'now' sends back-to-back with light spacing.
router.post('/bulk-outreach', async (req, res) => {
  try {
    const { candidateIds, mode = 'optimal', spacingMinutes = 2 } = req.body;
    if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
      return res.status(400).json({ error: 'candidateIds array is required' });
    }
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!emailConnected(user)) {
      return res.status(400).json({ error: 'No email provider connected. Connect Gmail, Zoho, or Outlook first.' });
    }
    if ((user.credits || 0) <= 0) {
      return res.status(402).json({ error: 'Insufficient credits. Ask your administrator to top up.', code: 'NO_CREDITS' });
    }

    const fallbackOffset = scheduling.userOffset(user);
    const all = await storage.getUserCandidates(req.session.userId);
    const byId = new Map(all.map(c => [c.id, c]));

    const jobs = [];
    let skipped = 0;
    candidateIds.forEach((cid, i) => {
      const c = byId.get(cid);
      if (!c || !c.email) { skipped++; return; }
      if ((c.stepsCompleted || {}).outreach) { skipped++; return; }  // already contacted

      let scheduledAt;
      if (mode === 'now') {
        scheduledAt = new Date(Date.now() + i * spacingMinutes * 60 * 1000).toISOString();
      } else {
        const locationText = `${c.location || ''} ${c.summary || ''}`;
        const base = new Date(Date.now() + i * spacingMinutes * 60 * 1000);
        scheduledAt = scheduling.nextSendTime({ locationText, fallbackOffset, from: base });
      }

      jobs.push({
        id:            uuidv4(),
        type:          'outreach',
        userId:        req.session.userId,
        candidateId:   c.id,
        candidateName: c.name,
        subject:       '',  // processor uses the AI-generated subject
        scheduledAt,
        status:        'pending',
        createdAt:     new Date().toISOString()
      });
    });

    if (!jobs.length) {
      return res.status(400).json({ error: 'No eligible candidates (all already contacted or missing email).', skipped });
    }
    queueSvc.addJobs(jobs);
    return res.json({ queued: jobs.length, skipped, mode });
  } catch (err) {
    console.error('Bulk queue error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/queue/outreach
// Body: { jobs: [{ candidateId, candidateName, subject, scheduledAt }] }
router.post('/outreach', async (req, res) => {
  try {
    const { jobs } = req.body;
    if (!Array.isArray(jobs) || jobs.length === 0) {
      return res.status(400).json({ error: 'jobs array is required' });
    }

    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const hasEmail = (user.gmail && user.gmail.connected) ||
      (user.zoho && user.zoho.connected && user.zoho.accessToken && user.zoho.refreshToken);
    if (!hasEmail) {
      return res.status(400).json({ error: 'No email provider connected. Connect Gmail or Zoho Mail in Settings first.' });
    }

    // Cancel any existing pending jobs so the user starts fresh
    queueSvc.cancelPendingForUser(req.session.userId);

    const queued = jobs.map(j => ({
      id:            uuidv4(),
      userId:        req.session.userId,
      candidateId:   j.candidateId,
      candidateName: j.candidateName,
      subject:       j.subject,
      scheduledAt:   j.scheduledAt,
      status:        'pending',
      createdAt:     new Date().toISOString()
    }));

    queueSvc.addJobs(queued);
    return res.json({ queued: queued.length, jobs: queued });
  } catch (err) {
    console.error('Queue create error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/queue/outreach — status of all jobs for the logged-in user
router.get('/outreach', (req, res) => {
  try {
    const jobs = queueSvc.getJobsForUser(req.session.userId);
    return res.json({ jobs });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/queue/outreach — cancel pending jobs
router.delete('/outreach', (req, res) => {
  try {
    queueSvc.cancelPendingForUser(req.session.userId);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
