const express    = require('express');
const router     = express.Router();
const { v4: uuidv4 } = require('uuid');
const requireAuth = require('../middleware/auth');
const queueSvc   = require('../services/queue');
const storage    = require('../services/storage');

router.use(requireAuth);

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
    if (!user.gmail || !user.gmail.connected) {
      return res.status(400).json({ error: 'Gmail not connected. Connect Gmail in Settings first.' });
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
