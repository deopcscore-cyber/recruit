const express    = require('express');
const router     = express.Router();
const claude     = require('../services/claude');
const storage    = require('../services/storage');
const requireAuth = require('../middleware/auth');

router.use(requireAuth);

// ── Credit helpers ────────────────────────────────────────────────────────────

async function checkCredits(user, res) {
  const balance = user.credits || 0;
  if (balance <= 0) {
    res.status(402).json({
      error: 'Insufficient credits. Please contact your administrator to add credits to your account.',
      code: 'NO_CREDITS'
    });
    return false;
  }
  return true;
}

async function deductCredits(user, costCents) {
  if (!costCents || costCents <= 0) return;
  user.credits    = Math.max(0, (user.credits    || 0) - costCents);
  user.totalSpent = (user.totalSpent || 0) + costCents;
  await storage.saveUser(user);
}

// ── Context helper ────────────────────────────────────────────────────────────

async function getContext(req, res) {
  const { candidateId } = req.body;
  if (!candidateId) {
    res.status(400).json({ error: 'candidateId is required' });
    return null;
  }
  const candidate = await storage.getCandidateById(candidateId);
  if (!candidate) { res.status(404).json({ error: 'Candidate not found' }); return null; }
  if (candidate.userId !== req.session.userId) { res.status(403).json({ error: 'Forbidden' }); return null; }
  const user = await storage.getUserById(req.session.userId);
  if (!user) { res.status(404).json({ error: 'User not found' }); return null; }
  return { candidate, user };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/ai/outreach
router.post('/outreach', async (req, res) => {
  try {
    const ctx = await getContext(req, res);
    if (!ctx) return;
    if (!await checkCredits(ctx.user, res)) return;

    const result = await claude.generateOutreach(ctx.candidate, ctx.user);
    await deductCredits(ctx.user, result.costCents);
    return res.json({ draft: result.text, creditsRemaining: ctx.user.credits });
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
    if (!await checkCredits(ctx.user, res)) return;

    const result = await claude.generateRoleJD(ctx.candidate, ctx.user);
    await deductCredits(ctx.user, result.costCents);
    return res.json({ draft: result.text, creditsRemaining: ctx.user.credits });
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
    if (!await checkCredits(ctx.user, res)) return;

    if (!ctx.candidate.resume?.text) {
      return res.status(400).json({ error: 'No resume on file for this candidate' });
    }

    const result = await claude.generateResumeFeedback(ctx.candidate, ctx.user);
    await deductCredits(ctx.user, result.costCents);
    return res.json({ gaps: result.gaps, draft: result.email, creditsRemaining: ctx.user.credits });
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
    if (!await checkCredits(ctx.user, res)) return;

    const result = await claude.generateVictoryEmail(ctx.candidate, ctx.user);
    await deductCredits(ctx.user, result.costCents);
    return res.json({ draft: result.text, creditsRemaining: ctx.user.credits });
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
    if (!await checkCredits(ctx.user, res)) return;

    const scoreData = await claude.scoreCandidate(ctx.candidate, ctx.user);
    await deductCredits(ctx.user, scoreData.costCents);

    ctx.candidate.score = scoreData.score;
    ctx.candidate.scoreDetails = { ...scoreData, scoredAt: new Date().toISOString() };
    await storage.saveCandidate(ctx.candidate);

    const { costCents, ...safeScore } = scoreData;
    return res.json({ ...safeScore, creditsRemaining: ctx.user.credits });
  } catch (err) {
    console.error('AI score error:', err);
    return res.status(500).json({ error: 'Failed to score candidate: ' + err.message });
  }
});

// POST /api/ai/followup
router.post('/followup', async (req, res) => {
  try {
    const ctx = await getContext(req, res);
    if (!ctx) return;
    if (!await checkCredits(ctx.user, res)) return;

    const result = await claude.generateFollowUp(ctx.candidate, ctx.user);
    await deductCredits(ctx.user, result.costCents);
    return res.json({ draft: result.text, creditsRemaining: ctx.user.credits });
  } catch (err) {
    console.error('AI followup error:', err);
    return res.status(500).json({ error: 'Failed to generate follow-up: ' + err.message });
  }
});

// POST /api/ai/reply
router.post('/reply', async (req, res) => {
  try {
    const ctx = await getContext(req, res);
    if (!ctx) return;
    if (!await checkCredits(ctx.user, res)) return;

    const { lastMessage } = req.body;
    const result = await claude.generateReply(ctx.candidate, ctx.user, lastMessage || null);
    await deductCredits(ctx.user, result.costCents);
    return res.json({ draft: result.text, creditsRemaining: ctx.user.credits });
  } catch (err) {
    console.error('AI reply error:', err);
    return res.status(500).json({ error: 'Failed to generate reply: ' + err.message });
  }
});

module.exports = router;
