const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const storage = require('../services/storage');
const requireAuth = require('../middleware/auth');
const zohoService = require('../services/zoho');

// All routes require auth
router.use(requireAuth);

// GET /api/settings
router.get('/', async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Auto-generate extension token on first access
    if (!user.extensionToken) {
      user.extensionToken = crypto.randomBytes(24).toString('hex');
      await storage.saveUser(user);
    }

    return res.json({
      ...(user.style || { tone: 'warm', notes: '', use: [], avoid: [] }),
      name: user.name || '',
      title: user.title || '',
      companyName: user.companyName || '',
      companyPitch: user.companyPitch || '',
      signature: user.signature || { enabled: false, photoUrl: '', website: '', location: '', linkedin: '', facebook: '', twitter: '', disclaimer: '' },
      secondaryTestEmail:  user.secondaryTestEmail  || '',
      hunterApiKey:        user.hunterApiKey        ? '••••••••' : '',
      contactOutApiKey:    user.contactOutApiKey    ? '••••••••' : '',
      apolloApiKey:        user.apolloApiKey        ? '••••••••' : '',
      extensionToken:           user.extensionToken           || '',
      userType:                 user.userType                 || 'recruiter_company',
      resumeConsultantName:     user.resumeConsultantName     || '',
      resumeConsultantEmail:    user.resumeConsultantEmail    || '',
      followUpConfig:           user.followUpConfig           || { enabled: true, steps: [{ days: 3 }, { days: 7 }] },
      autopilot:                Object.assign({ enabled:false, dailyCap:30, windowStart:'09:00', windowEnd:'17:00', weekdaysOnly:true, minSpacingMin:20, maxSpacingMin:60, warmup:true }, user.autopilot || {})
    });
  } catch (err) {
    console.error('Get settings error:', err);
    return res.status(500).json({ error: 'Failed to get settings' });
  }
});

// PUT /api/settings
router.put('/', async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { tone, notes, use, avoid, name, title, companyName, companyPitch, hunterApiKey, contactOutApiKey, apolloApiKey, signature, secondaryTestEmail, userType, resumeConsultantName, resumeConsultantEmail } = req.body;
    const VALID_TYPES = ['recruiter_company', 'recruiter_independent', 'career_consultant'];
    if (userType && VALID_TYPES.includes(userType)) user.userType = userType;

    user.style = user.style || {};
    if (tone !== undefined) user.style.tone = tone;
    if (notes !== undefined) user.style.notes = notes;
    if (use !== undefined) user.style.use = Array.isArray(use) ? use : [];
    if (avoid !== undefined) user.style.avoid = Array.isArray(avoid) ? avoid : [];

    // Profile fields
    if (name && name.trim()) user.name = name.trim();
    if (title !== undefined) user.title = title.trim();
    if (companyName  !== undefined) user.companyName  = companyName.trim();
    if (companyPitch !== undefined) user.companyPitch = companyPitch.trim();
    if (hunterApiKey     !== undefined) user.hunterApiKey     = hunterApiKey.trim();
    if (contactOutApiKey !== undefined) user.contactOutApiKey = contactOutApiKey.trim();
    if (apolloApiKey     !== undefined) user.apolloApiKey     = apolloApiKey.trim();

    // Secondary test email
    if (secondaryTestEmail !== undefined) user.secondaryTestEmail = secondaryTestEmail.trim();

    // Resume consultant partner (for recruiter Victory emails)
    if (resumeConsultantName  !== undefined) user.resumeConsultantName  = resumeConsultantName.trim();
    if (resumeConsultantEmail !== undefined) user.resumeConsultantEmail = resumeConsultantEmail.trim();

    // Daily auto-outreach (autopilot) config
    if (req.body.autopilot && typeof req.body.autopilot === 'object') {
      const ap = req.body.autopilot;
      const prev = user.autopilot || {};
      const clampInt = (v, lo, hi, dflt) => {
        const n = parseInt(v, 10);
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
      };
      const hm = (v, dflt) => /^\d{1,2}:\d{2}$/.test(String(v || '')) ? v : dflt;
      const enabled = !!ap.enabled;
      user.autopilot = {
        ...prev,
        enabled,
        dailyCap:      clampInt(ap.dailyCap, 1, 200, prev.dailyCap || 30),
        windowStart:   hm(ap.windowStart, prev.windowStart || '09:00'),
        windowEnd:     hm(ap.windowEnd,   prev.windowEnd   || '17:00'),
        weekdaysOnly:  ap.weekdaysOnly !== undefined ? !!ap.weekdaysOnly : (prev.weekdaysOnly !== false),
        minSpacingMin: clampInt(ap.minSpacingMin, 1, 240, prev.minSpacingMin || 20),
        maxSpacingMin: clampInt(ap.maxSpacingMin, 1, 480, prev.maxSpacingMin || 60),
        warmup:        ap.warmup !== undefined ? !!ap.warmup : (prev.warmup !== false)
      };
      // Stamp the warm-up start the first time it's switched on
      if (enabled && !prev.enabled) user.autopilot.startedAt = new Date().toISOString();
      // Ensure min ≤ max
      if (user.autopilot.minSpacingMin > user.autopilot.maxSpacingMin) {
        user.autopilot.maxSpacingMin = user.autopilot.minSpacingMin;
      }
    }

    // Automated follow-up sequence config
    if (req.body.followUpConfig && typeof req.body.followUpConfig === 'object') {
      const fc = req.body.followUpConfig;
      const steps = Array.isArray(fc.steps)
        ? fc.steps
            .map(s => ({ days: parseInt(s.days, 10) }))
            .filter(s => Number.isFinite(s.days) && s.days >= 1 && s.days <= 90)
            .slice(0, 5)
        : [];
      user.followUpConfig = {
        enabled: !!fc.enabled,
        steps: steps.length ? steps : [{ days: 3 }, { days: 7 }]
      };
    }

    // Signature fields
    if (signature !== undefined) {
      user.signature = user.signature || {};
      const fields = ['enabled', 'photoUrl', 'website', 'location', 'linkedin', 'facebook', 'twitter', 'disclaimer'];
      fields.forEach(f => { if (signature[f] !== undefined) user.signature[f] = signature[f]; });
    }

    await storage.saveUser(user);
    return res.json({
      ...user.style,
      name: user.name || '',
      title: user.title || '',
      companyName:  user.companyName  || '',
      companyPitch: user.companyPitch || '',
      hunterApiKey:     user.hunterApiKey     ? '••••••••' : '',
      contactOutApiKey: user.contactOutApiKey ? '••••••••' : '',
      apolloApiKey:     user.apolloApiKey     ? '••••••••' : '',
      signature: user.signature || {},
      secondaryTestEmail:       user.secondaryTestEmail       || '',
      userType:                 user.userType                 || 'recruiter_company',
      resumeConsultantName:     user.resumeConsultantName     || '',
      resumeConsultantEmail:    user.resumeConsultantEmail    || '',
      followUpConfig:           user.followUpConfig           || { enabled: true, steps: [{ days: 3 }, { days: 7 }] },
      autopilot:                Object.assign({ enabled:false, dailyCap:30, windowStart:'09:00', windowEnd:'17:00', weekdaysOnly:true, minSpacingMin:20, maxSpacingMin:60, warmup:true }, user.autopilot || {})
    });
  } catch (err) {
    console.error('Update settings error:', err);
    return res.status(500).json({ error: 'Failed to update settings' });
  }
});

// POST /api/settings/colleague — add a new user (colleague) account
router.post('/colleague', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = await storage.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const colleague = {
      id: uuidv4(),
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password: passwordHash,
      gmail: {
        connected: false,
        tokens: null,
        address: ''
      },
      style: {
        tone: 'warm',
        notes: '',
        use: [],
        avoid: []
      },
      createdAt: new Date().toISOString()
    };

    await storage.saveUser(colleague);

    return res.status(201).json({
      id: colleague.id,
      name: colleague.name,
      email: colleague.email
    });
  } catch (err) {
    console.error('Add colleague error:', err);
    return res.status(500).json({ error: 'Failed to add colleague' });
  }
});

// GET /api/settings/gmail-status
router.get('/gmail-status', async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const gmail = user.gmail || { connected: false, address: '' };
    return res.json({
      connected: gmail.connected || false,
      address: gmail.address || ''
    });
  } catch (err) {
    console.error('Gmail status error:', err);
    return res.status(500).json({ error: 'Failed to get Gmail status' });
  }
});

// DELETE /api/settings/gmail — disconnect Gmail
router.delete('/gmail', async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.gmail = {
      connected: false,
      tokens: null,
      address: ''
    };

    await storage.saveUser(user);
    return res.json({ success: true });
  } catch (err) {
    console.error('Disconnect Gmail error:', err);
    return res.status(500).json({ error: 'Failed to disconnect Gmail' });
  }
});

// ── Zoho Mail (OAuth2) ────────────────────────────────────────────────────────

// GET /api/settings/zoho-status
router.get('/zoho-status', async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const zoho = user.zoho || { connected: false, address: '' };
    return res.json({ connected: !!zoho.connected, address: zoho.address || '' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get Zoho status' });
  }
});

// GET /api/settings/zoho-connect — start OAuth2 flow
// state is a session-bound CSRF nonce; the callback verifies it and uses the
// session for identity (state must never carry a user ID).
router.get('/zoho-connect', async (req, res) => {
  try {
    const state = crypto.randomBytes(24).toString('hex');
    req.session.oauthState = state;
    const url = zohoService.getAuthUrl(state);
    return res.json({ url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/settings/zoho — disconnect
router.delete('/zoho', async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.zoho = { connected: false, address: '', accessToken: '', refreshToken: '' };
    await storage.saveUser(user);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to disconnect Zoho' });
  }
});

// ── Outlook (Microsoft) ───────────────────────────────────────────────────────
const outlookService = require('../services/outlook');

// GET /api/settings/outlook-status
router.get('/outlook-status', async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const outlook = user.outlook || {};
    return res.json({ connected: !!outlook.connected, address: outlook.address || '' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get Outlook status' });
  }
});

// GET /api/settings/outlook-connect — start OAuth2 flow
router.get('/outlook-connect', async (req, res) => {
  try {
    const state = crypto.randomBytes(24).toString('hex');
    req.session.oauthState = state;
    const url = outlookService.getAuthUrl(state);
    return res.json({ url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/settings/outlook — disconnect
router.delete('/outlook', async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.outlook = { connected: false, address: '', accessToken: '', refreshToken: '' };
    await storage.saveUser(user);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to disconnect Outlook' });
  }
});

// GET /api/settings/autopilot-status — live autopilot summary for the dashboard
router.get('/autopilot-status', async (req, res) => {
  try {
    const autopilot  = require('../services/autopilot');
    const queueSvc   = require('../services/queue');
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const cfg = autopilot.getConfig(user);
    const candidates = await storage.getUserCandidates(req.session.userId);
    const eligible = candidates.filter(c => c.email
      && (c.stage || 'Imported') === 'Imported'
      && !(c.stepsCompleted || {}).outreach
      && !(c.thread || []).some(m => m.direction === 'outbound')).length;

    const jobs = queueSvc.getJobsForUser(req.session.userId)
      .filter(j => j.source === 'autopilot');
    const pending = jobs.filter(j => j.status === 'pending');
    const today = new Date().toISOString().slice(0, 10);
    const sentToday = jobs.filter(j => j.status === 'sent' && (j.sentAt || '').slice(0, 10) === today).length;
    const nextAt = pending.map(j => j.scheduledAt).sort()[0] || null;

    return res.json({
      enabled: cfg.enabled,
      todaysCap: autopilot.effectiveCap(cfg, new Date()),
      dailyCap: cfg.dailyCap,
      warmup: cfg.warmup,
      eligibleRemaining: eligible,
      pendingToday: pending.length,
      sentToday,
      nextAt
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get autopilot status' });
  }
});

// GET /api/settings/credits — return current credit balance
router.get('/credits', async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({
      credits:    user.credits    || 0,
      totalSpent: user.totalSpent || 0,
      isAdmin:    user.isAdmin    || false
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get credits' });
  }
});

module.exports = router;
