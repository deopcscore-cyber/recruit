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
      aiProvider: require('../services/claude').getProviderInfo(),
      name: user.name || '',
      title: user.title || '',
      companyName: user.companyName || '',
      companyPitch: user.companyPitch || '',
      salaryRange: user.salaryRange || '',
      tzOffset: typeof user.tzOffset === 'number' ? user.tzOffset : null,
      signature: user.signature || { enabled: false, style: 'rich', customHtml: '', photoUrl: '', website: '', location: '', linkedin: '', facebook: '', twitter: '', disclaimer: '' },
      secondaryTestEmail:  user.secondaryTestEmail  || '',
      hunterApiKey:        user.hunterApiKey        ? '••••••••' : '',
      contactOutApiKey:    user.contactOutApiKey    ? '••••••••' : '',
      apolloApiKey:        user.apolloApiKey        ? '••••••••' : '',
      apifyApiKey:         user.apifyApiKey         ? '••••••••' : '',
      extensionToken:           user.extensionToken           || '',
      userType:                 user.userType                 || 'recruiter_company',
      aiProvider:               user.aiProvider               || 'auto',
      resumeConsultantName:     user.resumeConsultantName     || '',
      resumeConsultantEmail:    user.resumeConsultantEmail    || '',
      additionalDocs:           (Array.isArray(user.additionalDocs) && user.additionalDocs.length) ? user.additionalDocs : [{ name: 'Technical Statement of Qualifications (TSQ)', description: '' }, { name: 'Executive Bio', description: '' }],
      skipTeamContacted:        !!user.skipTeamContacted,
      skipUndeliverable:        !!user.skipUndeliverable,
      trackOpens:               user.trackOpens === true,
      outreachSample:           user.outreachSample           || '',
      subjectSample:            user.subjectSample            || '',
      outreachLength:           user.outreachLength           || 'standard',
      trackingDomain:           user.trackingDomain           || '',
      trackingDomainVerified:   !!user.trackingDomainVerified,
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
    const { tone, notes, use, avoid, name, title, companyName, companyPitch, salaryRange, hunterApiKey, contactOutApiKey, apolloApiKey, apifyApiKey, signature, secondaryTestEmail, userType, resumeConsultantName, resumeConsultantEmail } = req.body;

    // Atomic read-modify-write — a plain getUserById + saveUser here raced
    // with concurrent writes (e.g. a credit deduction mid-AI-generation)
    // and could silently wipe out whichever field this request just set.
    const user = await storage.updateUser(req.session.userId, (user) => {
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
    if (apifyApiKey      !== undefined) user.apifyApiKey      = apifyApiKey.trim();

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

    // Skip candidates other recruiters have already contacted, on import
    if (req.body.skipTeamContacted !== undefined) user.skipTeamContacted = !!req.body.skipTeamContacted;
    if (req.body.skipUndeliverable !== undefined) user.skipUndeliverable = !!req.body.skipUndeliverable;
    if (req.body.trackOpens !== undefined) user.trackOpens = !!req.body.trackOpens;

    // Additional documents requested when a resume is assessed "strong"
    // (TSQ, Executive Bio, …). Stored as [{name, description}], capped for sanity.
    if (Array.isArray(req.body.additionalDocs)) {
      user.additionalDocs = req.body.additionalDocs
        .map(d => ({ name: String(d.name || '').trim().slice(0, 120), description: String(d.description || '').trim().slice(0, 300) }))
        .filter(d => d.name)
        .slice(0, 15);
    }

    // Outreach style sample — AI mirrors this when generating outreach
    if (req.body.outreachSample !== undefined) user.outreachSample = String(req.body.outreachSample).slice(0, 4000);
    // Subject line sample — AI mirrors this style for all generated subjects
    if (req.body.subjectSample !== undefined) user.subjectSample = String(req.body.subjectSample).slice(0, 200);
    // Outreach length/tone — 'standard' (default) or 'short' (brief, casual)
    if (req.body.outreachLength !== undefined) user.outreachLength = req.body.outreachLength === 'short' ? 'short' : 'standard';
    // Custom open-tracking domain (e.g. track.theirdomain.com). Store the bare
    // hostname; changing it invalidates any prior verification so we never send
    // pixels from an unproven domain.
    if (req.body.trackingDomain !== undefined) {
      const cleaned = String(req.body.trackingDomain || '')
        .trim().toLowerCase()
        .replace(/^https?:\/\//, '')      // strip protocol
        .replace(/\/.*$/, '')             // strip any path
        .replace(/[:.]+$/, '');           // strip trailing dot/port junk
      const valid = cleaned === '' || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(cleaned);
      if (!valid) return res.status(400).json({ error: 'Enter a valid subdomain like track.yourdomain.com' });
      if (cleaned !== (user.trackingDomain || '')) {
        user.trackingDomain = cleaned;
        user.trackingDomainVerified = false;   // must re-verify after any change
      }
    }

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
      // Stamp the warm-up start only the FIRST time it's ever enabled — not on
      // every resume. Otherwise pausing for a break and resuming would reset
      // the ramp to day 0 and crater the daily cap back to ~10.
      if (enabled && !user.autopilot.startedAt) user.autopilot.startedAt = new Date().toISOString();
      // Re-enabling after a pause must clear today's once-per-day marker.
      // Without this, planDailyRun sees lastRunDate === today and refuses to
      // run for the rest of the day, so a pause+resume silently kills the whole
      // day's auto-sending (the same thing "Send batch now" already does at
      // /autopilot/run-now). planDailyRun subtracts whatever already sent today,
      // so re-planning can't exceed the daily cap.
      if (enabled && !prev.enabled) user.autopilot.lastRunDate = null;
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
      // Turning the sequence off should stop follow-ups that were already
      // queued — otherwise they keep firing until the queue drains.
      if (!fc.enabled) {
        const cancelled = require('../services/queue').cancelPendingAutoFollowUps(user.id);
        if (cancelled) console.log(`Follow-ups disabled for ${user.id} — cancelled ${cancelled} pending follow-up job(s)`);
      }
    }

    // Signature fields
    if (signature !== undefined) {
      user.signature = user.signature || {};
      const fields = ['enabled', 'style', 'customHtml', 'photoUrl', 'website', 'location', 'linkedin', 'facebook', 'twitter', 'disclaimer'];
      fields.forEach(f => { if (signature[f] !== undefined) user.signature[f] = signature[f]; });
    }

      return user;
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Pausing autopilot only ever stopped it from scheduling anything NEW —
    // outreach jobs it had already queued before the pause kept firing on
    // their original schedule, since the queue processor never re-checks
    // user.autopilot.enabled at send time. Cancel them here instead, the
    // moment the pause is actually saved. Scoped to source:'autopilot' so a
    // recruiter's own manual bulk-send batch isn't swept up in the same call.
    if (req.body.autopilot !== undefined && user.autopilot && !user.autopilot.enabled) {
      try { require('../services/queue').cancelPendingForUser(user.id, 'outreach', 'autopilot'); }
      catch (e) { console.error('Autopilot pause cleanup error:', e.message); }
    }

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
            await storage.updateUser(user.id, (u) => {
              u.autopilot = u.autopilot || {};
              u.autopilot.lastRunDate = plan.lastRunDate;
              return u;
            });
            user.autopilot.lastRunDate = plan.lastRunDate;
          }
        }
      } catch (e) { console.error('Autopilot immediate-run error:', e.message); }
    }

    return res.json({
      ...user.style,
      aiProvider: require('../services/claude').getProviderInfo(),
      name: user.name || '',
      title: user.title || '',
      companyName:  user.companyName  || '',
      companyPitch: user.companyPitch || '',
      hunterApiKey:     user.hunterApiKey     ? '••••••••' : '',
      contactOutApiKey: user.contactOutApiKey ? '••••••••' : '',
      apolloApiKey:     user.apolloApiKey     ? '••••••••' : '',
      apifyApiKey:      user.apifyApiKey      ? '••••••••' : '',
      signature: user.signature || {},
      secondaryTestEmail:       user.secondaryTestEmail       || '',
      userType:                 user.userType                 || 'recruiter_company',
      resumeConsultantName:     user.resumeConsultantName     || '',
      resumeConsultantEmail:    user.resumeConsultantEmail    || '',
      additionalDocs:           (Array.isArray(user.additionalDocs) && user.additionalDocs.length) ? user.additionalDocs : [{ name: 'Technical Statement of Qualifications (TSQ)', description: '' }, { name: 'Executive Bio', description: '' }],
      skipTeamContacted:        !!user.skipTeamContacted,
      skipUndeliverable:        !!user.skipUndeliverable,
      trackOpens:               user.trackOpens === true,
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

// POST /api/settings/tracking-domain/verify
// Confirms the user's custom tracking subdomain actually routes to THIS app
// over HTTPS (DNS + TLS + routing all working) before we rely on it for pixels.
router.post('/tracking-domain/verify', async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const domain = (user.trackingDomain || '').trim();
    if (!domain) return res.status(400).json({ error: 'Add a tracking domain and save it first' });

    const axios = require('axios');
    let ok = false, detail = '';
    try {
      const r = await axios.get(`https://${domain}/track/ping`, { timeout: 8000, validateStatus: () => true });
      ok = r.status === 200 && String(r.data).trim() === 'recruit-track-ok';
      if (!ok) detail = `Reached ${domain} but it didn't return the app's tracking marker (status ${r.status}). Make sure the CNAME points to this app and the domain is added to the app's host.`;
    } catch (err) {
      detail = `Could not reach https://${domain} — check the CNAME record and that HTTPS is provisioned. (${err.code || err.message})`;
    }

    user.trackingDomainVerified = ok;
    await storage.saveUser(user);
    return res.json({ verified: ok, error: ok ? undefined : detail });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Verification failed' });
  }
});

// POST /api/settings/signature/upload-inline-image
// Accepts a base64 data-URL image (from a pasted signature) and saves it to the
// hosted /photos store, returning a public URL. Pasted signatures often carry
// their images as data: URIs, which email clients strip — hosting them as a
// real URL is what makes the image actually show up in sent mail.
router.post('/signature/upload-inline-image', async (req, res) => {
  try {
    const { dataUrl } = req.body || {};
    const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(dataUrl || '');
    if (!m) return res.status(400).json({ error: 'Expected a base64 image data URL' });
    const extByMime = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
    const ext = extByMime[m[1].toLowerCase()] || '.png';
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length)              return res.status(400).json({ error: 'Empty image' });
    if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Image too large (max 5MB)' });
    const { BASE_URL } = require('../config');
    const fname = `${req.session.userId}-sig-${crypto.randomBytes(6).toString('hex')}${ext}`;
    fs.writeFileSync(path.join(PHOTOS_DIR, fname), buf);
    return res.json({ url: `${BASE_URL}/photos/${fname}` });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Upload failed' });
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
      && !c.bounced
      && (!user.skipUndeliverable || c.emailStatus !== 'undeliverable')   // matches the planner
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
