const express = require('express');
const router = express.Router();
const claude = require('../services/claude');
const storage = require('../services/storage');
const requireAuth = require('../middleware/auth');

// All routes require auth
router.use(requireAuth);

// Helper to get candidate + user, verify ownership
async function getContext(req, res) {
  const { candidateId } = req.body;
  if (!candidateId) {
    res.status(400).json({ error: 'candidateId is required' });
    return null;
  }

  const candidate = await storage.getCandidateById(candidateId);
  if (!candidate) {
    res.status(404).json({ error: 'Candidate not found' });
    return null;
  }
  if (candidate.userId !== req.session.userId) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }

  const user = await storage.getUserById(req.session.userId);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return null;
  }

  return { candidate, user };
}

// POST /api/ai/outreach
router.post('/outreach', async (req, res) => {
  try {
    const ctx = await getContext(req, res);
    if (!ctx) return;

    const draft = await claude.generateOutreach(ctx.candidate, ctx.user);
    return res.json({ draft });
  } catch (err) {
    console.error('AI outreach error:', err);
    return res.status(500).json({ error: 'Failed to generate outreach: ' + err.message });
  }
});

// POST /api/ai/role-jd
router.post('/role-jd', async (req, res) => {
  try {
    const ctx = await getContext(req, res);
    if (!ctx) return;

    const draft = await claude.generateRoleJD(ctx.candidate, ctx.user);
    return res.json({ draft });
  } catch (err) {
    console.error('AI role JD error:', err);
    return res.status(500).json({ error: 'Failed to generate role JD: ' + err.message });
  }
});

// POST /api/ai/resume-review
router.post('/resume-review', async (req, res) => {
  try {
    const ctx = await getContext(req, res);
    if (!ctx) return;

    if (!ctx.candidate.resume || !ctx.candidate.resume.text) {
      return res.status(400).json({ error: 'No resume on file for this candidate' });
    }

    const result = await claude.generateResumeFeedback(ctx.candidate, ctx.user);
    return res.json({ gaps: result.gaps, draft: result.email });
  } catch (err) {
    console.error('AI resume review error:', err);
    return res.status(500).json({ error: 'Failed to generate resume review: ' + err.message });
  }
});

// POST /api/ai/victory
router.post('/victory', async (req, res) => {
  try {
    const ctx = await getContext(req, res);
    if (!ctx) return;

    const draft = await claude.generateVictoryEmail(ctx.candidate, ctx.user);
    return res.json({ draft });
  } catch (err) {
    console.error('AI victory error:', err);
    return res.status(500).json({ error: 'Failed to generate Victory email: ' + err.message });
  }
});

// POST /api/ai/score
router.post('/score', async (req, res) => {
  try {
    const ctx = await getContext(req, res);
    if (!ctx) return;

    const scoreData = await claude.scoreCandidate(ctx.candidate, ctx.user);

    // Save score to candidate
    ctx.candidate.score = scoreData.score;
    ctx.candidate.scoreDetails = { ...scoreData, scoredAt: new Date().toISOString() };
    await storage.saveCandidate(ctx.candidate);

    return res.json(scoreData);
  } catch (err) {
    console.error('AI score error:', err);
    return res.status(500).json({ error: 'Failed to score candidate: ' + err.message });
  }
});

// POST /api/ai/reply
router.post('/reply', async (req, res) => {
  try {
    const ctx = await getContext(req, res);
    if (!ctx) return;

    const { lastMessage } = req.body;
    const draft = await claude.generateReply(ctx.candidate, ctx.user, lastMessage || null);
    return res.json({ draft });
  } catch (err) {
    console.error('AI reply error:', err);
    return res.status(500).json({ error: 'Failed to generate reply: ' + err.message });
  }
});

module.exports = router;
