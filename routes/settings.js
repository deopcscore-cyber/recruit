const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const storage = require('../services/storage');
const requireAuth = require('../middleware/auth');
const zohoService = require('../services/zoho');
const { DATA_DIR } = require('../config');

const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, PHOTOS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `${req.session.userId}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

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
      salaryRange: user.salaryRange || '',
      tzOffset: typeof user.tzOffset === 'number' ? user.tzOffset : null,
      signature: user.signature || { enabled: false, photoUrl: '', website: '', location: '', linkedin: '', facebook: '', twitter: '', disclaimer: '' },
      secondaryTestEmail:  user.secondaryTestEmail  || '',
      hunterApiKey:        user.hunterApiKey        ? '••••••••' : '',
      contactOutApiKey:    user.contactOutApiKey    ? '••••••••' : '',
      apolloApiKey:        user.apolloApiKey        ? '••••••••' : '',
      extensionToken:           user.extensionToken           || '',
      userType:                 user.userType                 || 'recruiter_company',
      aiProvider:               user.aiProvider               || 'auto',
      resumeConsultantName:     user.resumeConsultantName     || '',
      resumeConsultantEmail:    user.resumeConsultantEmail    || '',
      outreachSample:           user.outreachSample           || '',
      subjectSample:            user.subjectSample            || '',
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

    const { tone, notes, use, avoid, name, title, companyName, companyPitch, salaryRange, hunterApiKey, contactOutApiKey, apolloApiKey, signature, secondaryTestEmail, userType, resumeConsultantName, resumeConsultantEmail } = req.body;
    const VALID_TYPES = ['recruiter_company', 'recruiter_independent', 'career_consultant'];
    if (userType && VALID_TYPES.includes(userType)) user.userType = userType;

    // AI provider preference: auto (default per user type) | openai | claude
    if (req.body.aiProvider !== undefined) {
      const VALID_PROVIDERS = ['auto', 'openai', 'claude'];
      if (VALID_PROVIDERS.includes(req.body.aiProvider)) {
        user.aiProvider = req.body.aiProvider === 'auto' ? '' : req.body.aiProvider;
      }
    }

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
    if (salaryRange  !== undefined) user.salaryRange  = salaryRange.trim();
    if (hunterApiKey     !== undefined) user.hunterApiKey     = hunterApiKey.trim();
    if (contactOutApiKey !== undefined) user.contactOutApiKey = contactOutApiKey.trim();
    if (apolloApiKey     !== undefined) user.apolloApiKey     = apolloApiKey.trim();

    // Secondary test email
    if (secondaryTestEmail !== undefined) user.secondaryTestEmail = secondaryTestEmail.trim();

    // Real browser timezone offset (hours, e.g. +1, -5) — used for send windows
    if (req.body.tzOffset !== undefined) {
      const tz = Number(req.body.tzOffset);
      if (Number.isFinite(tz) && tz >= -12 && tz <= 14) user.tzOffset = tz;
    }

    // Resume consultant partner (for recruiter Victory emails)
    if (resumeConsultantName  !== undefined) user.resumeConsultantName  = resumeConsultantName.trim();
    if (resumeConsultantEmail !== undefined) user.resumeConsultantEmail = resumeConsultantEmail.trim();

    // Outreach style sample — AI mirrors this when generating outreach
    if (req.body.outreachSample !== undefined) user.outreachSample = String(req.body.outreachSample).slice(0, 4000);
    // Subject line sample — AI mirrors this style for all generated subjects
    if (req.body.subjectSample !== undefined) user.subjectSample = String(req.body.subjectSample).slice(0, 200);

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

    // If autopilot is on, plan today's batch immediately so jobs queue right
    // away instead of waiting up to 15 min for the background loop.
    if (user.autopilot && user.autopilot.enabled) {
      try {
        const autopilot = require('../services/autopilot');
        const queueSvc  = require('../services/queue');
        const emailConnected = !!(user.gmail?.connected)
          || !!(user.zoho?.connected && user.zoho.accessToken)
          || !!(user.outlook?.connected && user.outlook.accessToken);
        if (emailConnected && (user.credits || 0) > 0) {
          const cands = await storage.getUserCandidates(user.id);
          const plan = autopilot.planDailyRun(user, cands, new Date());
          if (plan.ran) {
            if (plan.jobs && plan.jobs.length) {
              queueSvc.cancelPendingForUser(user.id, 'outreach');
              queueSvc.addJobs(plan.jobs);
            }
            user.autopilot.lastRunDate = plan.lastRunDate;
            await storage.saveUser(user);
          }
        }
      } catch (e) { console.error('Autopilot immediate-run error:', e.message); }
    }

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
      outreachSample:           user.outreachSample           || '',
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

// POST /api/settings/signature/upload-photo
router.post('/signature/upload-photo', photoUpload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file received' });
    const { BASE_URL } = require('../config');
    const ext = path.extname(req.file.filename);
    const url = `${BASE_URL}/photos/${req.session.userId}${ext}`;
    // Save to user signature too
    const user = await storage.getUserById(req.session.userId);
    if (user) {
      user.signature = user.signature || {};
      user.signature.photoUrl = url;
      await storage.saveUser(user);
    }
    return res.json({ url });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

// POST /api/settings/signature/linkedin-prefill
// Fetches a LinkedIn public profile URL and extracts OG meta tags
// to pre-populate signature fields without any external API.
router.post('/signature/linkedin-prefill', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || !url.includes('linkedin.com/in/')) {
      return res.status(400).json({ error: 'Please paste a valid LinkedIn profile URL' });
    }

    const https = require('https');
    const html = await new Promise((resolve, reject) => {
      const opts = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html'
        }
      };
      https.get(url, opts, r => {
        let data = '';
        r.on('data', chunk => { data += chunk; if (data.length > 200000) r.destroy(); });
        r.on('end', () => resolve(data));
        r.on('error', reject);
      }).on('error', reject).setTimeout(8000, function() { this.destroy(); reject(new Error('timeout')); });
    });

    const og = (prop) => {
      const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))
             || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'));
      return m ? m[1].replace(/&amp;/g,'&').replace(/&#39;/g,"'").trim() : '';
    };

    const fullTitle = og('og:title') || og('title');
    // LinkedIn og:title format: "Name - Title at Company | LinkedIn"
    const withoutSuffix = fullTitle.replace(/\s*\|\s*LinkedIn\s*$/i, '').trim();
    const dashIdx = withoutSuffix.indexOf(' - ');
    const name    = dashIdx > -1 ? withoutSuffix.slice(0, dashIdx).trim() : withoutSuffix;
    const rest    = dashIdx > -1 ? withoutSuffix.slice(dashIdx + 3).trim() : '';

    // "Title at Company" or just "Title"
    const atIdx   = rest.search(/ at /i);
    const title   = atIdx > -1 ? rest.slice(0, atIdx).trim() : rest;
    const company = atIdx > -1 ? rest.slice(atIdx + 4).trim() : '';

    const photo = og('og:image');

    // Location often in description: "Location · connections · ..."
    const desc = og('og:description');
    const locMatch = desc.match(/^([^·•\n]+(?:Area|Region|City|State|Country|Metropolitan)?[^·•\n]*?)(?:\s*[·•]|$)/i);
    const location = locMatch ? locMatch[1].trim() : '';

    return res.json({ name, title, company, photo, location });
  } catch (err) {
    return res.status(500).json({ error: 'Could not read that LinkedIn profile — make sure it\'s a public profile URL' });
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
    // Revoke tokens with Zoho so next connect is treated as a fresh grant
    // (Zoho only returns a refresh_token on first authorization unless revoked first)
    await zohoService.revokeTokens(user).catch(() => {});
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
    const failedToday = jobs.filter(j => j.status === 'failed' && (j.createdAt || '').slice(0, 10) === today);
    const nextAt = pending.map(j => j.scheduledAt).sort()[0] || null;

    // Is any email provider connected?
    const emailConnected = !!(user.gmail?.connected)
      || !!(user.zoho?.connected && user.zoho.accessToken)
      || !!(user.outlook?.connected && user.outlook.accessToken);

    // Why isn't it sending? (no email / no credits / weekend / no candidates / window)
    const diag = autopilot.diagnose(user, {
      emailConnected,
      credits: user.credits || 0,
      eligible,
      now: new Date()
    });

    return res.json({
      enabled: cfg.enabled,
      todaysCap: autopilot.effectiveCap(cfg, new Date()),
      dailyCap: cfg.dailyCap,
      warmup: cfg.warmup,
      eligibleRemaining: eligible,
      pendingToday: pending.length,
      sentToday,
      failedToday: failedToday.length,
      lastError: failedToday.length ? (failedToday[failedToday.length - 1].error || '') : '',
      nextAt,
      emailConnected,
      ok: diag.ok,
      blocker: diag.blocker,
      statusMessage: diag.message,
      lastRunDate: cfg.lastRunDate || null
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get autopilot status' });
  }
});

// POST /api/settings/autopilot/run-now — force a planning pass right now.
// Bypasses the once-per-day guard and the send window so the user can kick off
// (and verify) sending on demand. Returns exactly what happened.
router.post('/autopilot/run-now', async (req, res) => {
  try {
    const autopilot = require('../services/autopilot');
    const queueSvc  = require('../services/queue');
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.autopilot || !user.autopilot.enabled) {
      return res.status(400).json({ error: 'Enable auto-outreach first, then run.' });
    }

    const emailConnected = !!(user.gmail?.connected)
      || !!(user.zoho?.connected && user.zoho.accessToken)
      || !!(user.outlook?.connected && user.outlook.accessToken);
    if (!emailConnected) return res.status(400).json({ error: 'No email account connected. Connect one in the Email tab first.' });
    if ((user.credits || 0) <= 0) return res.status(402).json({ error: 'Out of credits — add credits to send.' });

    const candidates = await storage.getUserCandidates(req.session.userId);

    // Cancel any stale pending jobs, clear today's guard, re-plan within the actual window
    queueSvc.cancelPendingForUser(req.session.userId, 'outreach');
    user.autopilot.lastRunDate = null;
    await storage.saveUser(user);

    const plan = autopilot.planDailyRun(user, candidates, new Date());

    if (!plan.ran) {
      const msgs = {
        after_window: `Today's send window has ended. Auto-outreach will resume tomorrow at ${user.autopilot.windowStart || '09:00'}.`,
        before_window: `Outside send window — emails will start at ${user.autopilot.windowStart || '09:00'}.`,
        weekend: 'Weekend — weekdays-only mode is on.',
        disabled: 'Auto-outreach is disabled.',
      };
      return res.json({ queued: 0, message: msgs[plan.reason] || `Not running: ${plan.reason}` });
    }
    if (!plan.jobs || !plan.jobs.length) {
      return res.json({ queued: 0, message: 'No uncontacted imported candidates left to email.' });
    }

    queueSvc.addJobs(plan.jobs);
    user.autopilot.lastRunDate = plan.lastRunDate;
    await storage.saveUser(user);

    const nextAt = plan.jobs[0].scheduledAt;
    return res.json({
      queued: plan.jobs.length,
      nextAt,
      message: `Queued ${plan.jobs.length} — first sends at ${new Date(nextAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, spaced ${user.autopilot.minSpacingMin || 10}–${user.autopilot.maxSpacingMin || 60} min apart.`
    });
  } catch (err) {
    console.error('Autopilot run-now error:', err);
    return res.status(500).json({ error: 'Run failed: ' + err.message });
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

// GET /api/settings/credit-history — return usage log
router.get('/credit-history', async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const history = (user.creditHistory || []).slice(0, 200);
    return res.json({ history, credits: user.credits || 0, totalSpent: user.totalSpent || 0 });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get credit history' });
  }
});

// GET /api/settings/ai-status — which AI provider is active for this user
router.get('/ai-status', async (req, res) => {
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAI    = !!process.env.OPENAI_API_KEY;

  // Effective preference: explicit setting wins, otherwise consultants get Claude
  let claudeFirst = false;
  try {
    const user = await storage.getUserById(req.session.userId);
    if (user?.aiProvider === 'claude') claudeFirst = true;
    else if (user?.aiProvider === 'openai') claudeFirst = false;
    else claudeFirst = user?.userType === 'career_consultant';
  } catch {}

  let primary, fallback = null;
  if (claudeFirst && hasAnthropic) {
    primary  = 'Claude (claude-sonnet-4-6)';
    fallback = hasOpenAI ? 'GPT-4o-mini (auto-switches if Claude is unavailable)' : null;
  } else if (hasOpenAI) {
    primary  = 'GPT-4o-mini';
    fallback = hasAnthropic ? 'Claude (auto-switches if OpenAI is unavailable)' : null;
  } else {
    primary = hasAnthropic ? 'Claude (claude-sonnet-4-6)' : 'None';
  }
  res.json({ primary, fallback, hasAnthropic, hasOpenAI });
});

// ── SMTP / IMAP ───────────────────────────────────────────────────────────────

// GET /api/settings/smtp
router.get('/smtp', async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const cfg = user.smtp || {};
    // Never return the password
    res.json({
      connected:  cfg.connected  || false,
      host:       cfg.host       || '',
      port:       cfg.port       || 587,
      secure:     cfg.secure     || false,
      username:   cfg.username   || '',
      fromName:   cfg.fromName   || '',
      fromEmail:  cfg.fromEmail  || '',
      imapHost:   cfg.imapHost   || '',
      imapPort:   cfg.imapPort   || 993,
      imapSecure: cfg.imapSecure !== false
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/smtp — save and optionally test
router.post('/smtp', async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { host, port, username, password, fromName, fromEmail, imapHost, imapPort, skipTest } = req.body;
    if (!host || !username || !password) {
      return res.status(400).json({ error: 'host, username, and password are required' });
    }

    const smtpSvc = require('../services/smtp');
    const cfg = {
      host: host.trim(),
      port: parseInt(port) || 587,
      secure: parseInt(port) === 465,
      username: username.trim(),
      password,
      fromName: (fromName || '').trim() || user.name || '',
      fromEmail: (fromEmail || '').trim() || username.trim(),
      imapHost: (imapHost || '').trim() || host.trim(),
      imapPort: parseInt(imapPort) || 993,
      imapSecure: true
    };

    const warnings = [];

    if (!skipTest) {
      // Test SMTP
      try { await smtpSvc.testSmtp(cfg); } catch (e) {
        const isTimeout = /timeout|ETIMEDOUT|ECONNREFUSED/i.test(e.message);
        if (isTimeout) {
          // Save anyway but warn — cloud hosting often blocks test connections
          // while actual email delivery still works
          warnings.push('SMTP connection test timed out (your host may block test connections from cloud servers). Credentials saved — send a test email to verify.');
        } else {
          return res.status(400).json({ error: 'SMTP connection failed: ' + e.message });
        }
      }
      // Test IMAP only if SMTP passed
      if (warnings.length === 0) {
        try { await smtpSvc.testImap(cfg); } catch (e) {
          const isTimeout = /timeout|ETIMEDOUT|ECONNREFUSED/i.test(e.message);
          if (isTimeout) {
            warnings.push('IMAP connection test timed out. Credentials saved — reply fetching will attempt when you run Fetch Replies.');
          } else {
            return res.status(400).json({ error: 'IMAP connection failed: ' + e.message });
          }
        }
      }
    }

    user.smtp = { ...cfg, connected: true };
    await storage.saveUser(user);
    res.json({ success: true, fromEmail: cfg.fromEmail, warnings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/settings/smtp
router.delete('/smtp', async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    delete user.smtp;
    await storage.saveUser(user);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
