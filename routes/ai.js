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

async function deductCredits(user, costCents, action, candidateName) {
  if (!costCents || costCents <= 0) return;

  // Atomic read-modify-write, keyed off the on-disk balance at write time —
  // not the possibly-stale `user` snapshot from request start. A plain
  // getUserById-then-saveUser here raced with concurrent requests (settings
  // saves, other AI calls) and could silently drop either side's write.
  const updated = await storage.updateUser(user.id, (u) => {
    u.credits    = Math.max(0, (u.credits    || 0) - costCents);
    u.totalSpent = (u.totalSpent || 0) + costCents;
    if (!u.creditHistory) u.creditHistory = [];
    u.creditHistory.unshift({
      ts:        new Date().toISOString(),
      action:    action || 'AI generation',
      candidate: candidateName || null,
      cost:      costCents
    });
    if (u.creditHistory.length > 500) u.creditHistory = u.creditHistory.slice(0, 500);
    return u;
  });

  // Reflect the persisted values onto the caller's in-memory user object
  // so the response (creditsRemaining etc.) shows the real post-write balance.
  if (updated) {
    user.credits      = updated.credits;
    user.totalSpent   = updated.totalSpent;
    user.creditHistory = updated.creditHistory;
  }
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

    const result = await claude.generateOutreach(ctx.candidate, ctx.user, req.body.instructions);
    await deductCredits(ctx.user, result.costCents, 'Outreach email', ctx.candidate.name);
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

    const result = await claude.generateRoleJD(ctx.candidate, ctx.user, req.body.instructions);
    await deductCredits(ctx.user, result.costCents, 'Role & JD', ctx.candidate.name);
    return res.json({
      draft: result.text,
      subject: result.subject,
      variants: result.variants,
      jdLocation: result.jdLocation,
      creditsRemaining: ctx.user.credits
    });
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

    const result = await claude.generateResumeFeedback(ctx.candidate, ctx.user, req.body.instructions);
    await deductCredits(ctx.user, result.costCents, 'Resume review', ctx.candidate.name);
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

    const result = await claude.generateVictoryEmail(ctx.candidate, ctx.user, req.body.instructions);
    await deductCredits(ctx.user, result.costCents, 'Intro email', ctx.candidate.name);
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
    await deductCredits(ctx.user, scoreData.costCents, 'Candidate score', ctx.candidate.name);

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

    const result = await claude.generateFollowUp(ctx.candidate, ctx.user, req.body.instructions);
    await deductCredits(ctx.user, result.costCents, 'Follow-up email', ctx.candidate.name);
    return res.json({ draft: result.text, creditsRemaining: ctx.user.credits });
  } catch (err) {
    console.error('AI followup error:', err);
    return res.status(500).json({ error: 'Failed to generate follow-up: ' + err.message });
  }
});

// POST /api/ai/proposal  (career consultant only)
router.post('/proposal', async (req, res) => {
  try {
    const ctx = await getContext(req, res);
    if (!ctx) return;
    if (!await checkCredits(ctx.user, res)) return;

    const result = await claude.generateProposal(ctx.candidate, ctx.user, req.body.instructions);
    await deductCredits(ctx.user, result.costCents, 'Proposal', ctx.candidate.name);
    return res.json({ draft: result.text, creditsRemaining: ctx.user.credits });
  } catch (err) {
    console.error('AI proposal error:', err);
    return res.status(500).json({ error: 'Failed to generate proposal: ' + err.message });
  }
});

// POST /api/ai/reply
router.post('/reply', async (req, res) => {
  try {
    const ctx = await getContext(req, res);
    if (!ctx) return;
    if (!await checkCredits(ctx.user, res)) return;

    const { lastMessage, instructions } = req.body;
    const result = await claude.generateReply(ctx.candidate, ctx.user, lastMessage || null, instructions);
    await deductCredits(ctx.user, result.costCents, 'Reply draft', ctx.candidate.name);
    return res.json({ draft: result.text, creditsRemaining: ctx.user.credits });
  } catch (err) {
    console.error('AI reply error:', err);
    return res.status(500).json({ error: 'Failed to generate reply: ' + err.message });
  }
});

// POST /api/ai/rewrite-resume  (career consultant deliverable — before/after)
router.post('/rewrite-resume', async (req, res) => {
  try {
    const ctx = await getContext(req, res);
    if (!ctx) return;
    if (!await checkCredits(ctx.user, res)) return;
    if (!ctx.candidate.resume?.text) {
      return res.status(400).json({ error: 'No resume on file for this candidate' });
    }

    const result = await claude.rewriteResume(ctx.candidate, ctx.user);
    await deductCredits(ctx.user, result.costCents, 'Resume rewrite', ctx.candidate.name);

    // Persist so it can be re-opened without paying to regenerate
    ctx.candidate.resumeRewrite = {
      rewritten: result.rewritten,
      summary:   result.summary,
      generatedAt: new Date().toISOString()
    };
    await storage.saveCandidate(ctx.candidate);

    return res.json({
      original: result.original,
      rewritten: result.rewritten,
      summary: result.summary,
      creditsRemaining: ctx.user.credits
    });
  } catch (err) {
    console.error('AI rewrite-resume error:', err);
    return res.status(500).json({ error: 'Failed to rewrite resume: ' + err.message });
  }
});

module.exports = router;
