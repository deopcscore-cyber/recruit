/* ============================================================
   Recruit Pro — LinkedIn Profile Import Routes
   ============================================================ */

const express    = require('express');
const router     = express.Router();
const crypto     = require('crypto');
const { v4: uuidv4 } = require('uuid');
const requireAuth = require('../middleware/auth');
const linkedinSvc = require('../services/linkedin');
const storage    = require('../services/storage');

/* ── In-memory token store for bookmarklet one-shot imports ──────────────────
   Tokens expire in 10 minutes and are deleted on first use.
   No auth required — the token itself is the secret.            */
const pendingImports = new Map();

function cleanExpired() {
  const now = Date.now();
  for (const [k, v] of pendingImports) if (v.expires < now) pendingImports.delete(k);
}

const rateLimit = require('../middleware/rateLimit');
const bookmarkletLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, message: 'Too many imports — wait a minute and try again.' });

// POST /api/linkedin/bookmarklet — called by the li-capture popup on OUR origin
// (the bookmarklet on linkedin.com relays page text to the popup via postMessage),
// so the session cookie is present. Auth required — this endpoint runs a Claude
// parse on the server's API key and was previously an open cost-abuse vector.
router.post('/bookmarklet', requireAuth, bookmarkletLimiter, async (req, res) => {
  // coEmails: optional array of emails already harvested by the Chrome extension
  // (e.g. read from ContactOut's injected DOM on the same page)
  const { url, text, coEmails } = req.body;
  if (!text || text.trim().length < 50) {
    return res.status(400).json({ error: 'Profile text is too short — make sure you copied the full page.' });
  }
  try {
    const user = await storage.getUserById(req.session.userId);
    const profile = await linkedinSvc.parseFromText(text, url || '', user);
    if (!profile || !profile.name) {
      return res.status(422).json({ error: 'Could not extract a name from the profile text. Try selecting more of the page.' });
    }

    // If the Chrome extension already harvested emails from ContactOut's DOM,
    // store them on the profile so the dashboard can pre-fill the email field.
    const PERSONAL_RE = /@(gmail|yahoo|hotmail|outlook|icloud|me|live|aol|protonmail|pm)\./i;
    const extraEmails = Array.isArray(coEmails) ? coEmails.filter(e => e && e.includes('@')) : [];
    const personalEmail = extraEmails.find(e => PERSONAL_RE.test(e)) || '';
    const workEmail     = extraEmails.find(e => !PERSONAL_RE.test(e)) || '';
    const bestEmail     = personalEmail || workEmail || extraEmails[0] || '';

    const token = crypto.randomBytes(10).toString('hex');
    cleanExpired();
    pendingImports.set(token, {
      profile: {
        ...profile,
        linkedin:      url || '',
        // Pre-populate email fields if ContactOut data was available
        email:         bestEmail,
        personalEmail: personalEmail,
        workEmail:     workEmail,
        emailSource:   bestEmail ? 'ContactOut (extension)' : ''
      },
      expires: Date.now() + 10 * 60 * 1000
    });
    return res.json({ token });
  } catch (err) {
    console.error('Bookmarklet parse error:', err);
    return res.status(500).json({ error: 'Parse failed: ' + err.message });
  }
});

// GET /api/linkedin/bookmarklet/:token  — dashboard retrieves the parsed profile
// One-time token + session auth (dashboard is always logged in); expires in 10 min
router.get('/bookmarklet/:token', requireAuth, (req, res) => {
  cleanExpired();
  const entry = pendingImports.get(req.params.token);
  if (!entry) return res.status(404).json({ error: 'Import token not found or expired. Please run the bookmarklet again.' });
  pendingImports.delete(req.params.token); // one-time use
  return res.json(entry.profile);
});

// ── Extension quick-import (no session — uses per-user extension token) ───────
// POST /api/linkedin/quick-import
// Called directly by the Chrome extension's background service worker.
// Auth: X-Extension-Token header — a per-user secret stored in user.extensionToken.
// Returns { success, candidate } and saves directly to the pipeline.
// No tab redirect needed — the extension stays on LinkedIn.
//
// Registered BEFORE router.use(requireAuth) below — this route deliberately
// does its own token-based auth instead of session auth (a Chrome extension
// background worker has no session cookie for the app's domain; it never
// even sends one, since a cross-origin fetch without credentials:'include'
// doesn't carry cookies). It used to be registered after requireAuth, which
// meant every request 401'd before this handler's own token check ever ran
// — the route was unreachable from the extension entirely.
router.post('/quick-import', async (req, res) => {
  // CORS for Chrome extension origins
  const origin = req.headers.origin || '';
  if (origin.startsWith('chrome-extension://')) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Extension-Token');
  }

  const token = req.headers['x-extension-token'];
  if (!token) return res.status(401).json({ error: 'Missing extension token. Open the extension popup and re-enter your token.' });

  try {
    // Look up user by extension token
    const users = await storage.getAllUsers();
    const user = users.find(u => u.extensionToken === token);
    if (!user) return res.status(401).json({ error: 'Invalid extension token. Copy it again from Settings → Account.' });

    const { url, text, sections, coEmails } = req.body;
    if (!sections?.name && (!text || text.trim().length < 50)) {
      return res.status(400).json({ error: 'Profile text too short — make sure you\'re on a LinkedIn profile page.' });
    }

    // 1. Parse profile — prefer the extension's DOM-extracted sections
    // (deterministic: name/headline/location/about need no AI at all, pulled
    // straight from the page structure) over the old whole-page-text AI
    // parse, which had to find the signal in a haystack of nav/ads/feed
    // content. Only the free-form experience/education text — genuinely
    // variable-shaped (single roles, grouped multi-role-per-company, etc.)
    // — still goes through AI, and only that isolated section text rather
    // than the entire page. Falls back to the old full-page AI parse when
    // the extension couldn't match the page's expected structure (redesign,
    // unusual layout) — sections comes back null in that case.
    let profile;
    if (sections && sections.name) {
      const aiInput = [sections.experienceText, sections.educationText].filter(Boolean).join('\n\n');
      const structured = aiInput
        ? await linkedinSvc.parseFromText(aiInput, url || '', user).catch(() => ({ career: [], education: [] }))
        : { career: [], education: [] };
      const { title, company } = linkedinSvc.splitHeadline(sections.headline);
      profile = {
        name:     sections.name,
        title:    title    || structured.title    || '',
        company:  company  || structured.company  || '',
        location: sections.location || structured.location || '',
        summary:  sections.about    || structured.summary  || '',
        career:    Array.isArray(structured.career)    ? structured.career    : [],
        education: Array.isArray(structured.education) ? structured.education : []
      };
    } else {
      profile = await linkedinSvc.parseFromText(text, url || '', user);
    }
    if (!profile || !profile.name) {
      return res.status(422).json({ error: 'Could not extract a name — try a different profile.' });
    }

    // 2. Build email from ContactOut DOM data first (already on the page)
    const PERSONAL_RE = /@(gmail|yahoo|hotmail|outlook|icloud|me|live|aol|protonmail|pm)\./i;
    const extras = Array.isArray(coEmails) ? coEmails.filter(e => e && e.includes('@')) : [];
    let personalEmail = extras.find(e => PERSONAL_RE.test(e)) || '';
    let workEmail     = extras.find(e => !PERSONAL_RE.test(e)) || '';
    let emailSource   = (personalEmail || workEmail) ? 'ContactOut (extension)' : '';

    // 3. Fill gaps with server-side enrichment APIs
    if (!personalEmail || !workEmail) {
      const enriched = await linkedinSvc.enrichContact({
        name:             profile.name,
        company:          profile.company,
        linkedinUrl:      url || '',
        hunterApiKey:     user.hunterApiKey     || '',
        contactOutApiKey: user.contactOutApiKey  || '',
        apolloApiKey:     user.apolloApiKey      || ''
      });
      if (!personalEmail && enriched.personalEmail) { personalEmail = enriched.personalEmail; emailSource = enriched.source; }
      if (!workEmail     && enriched.workEmail)     { workEmail     = enriched.workEmail; }
      if (!personalEmail && enriched.email)         { personalEmail = enriched.email;     emailSource = enriched.source; }
    }

    // Prefer a personal email, but import on a work email rather than skip
    // the candidate entirely — still worth reaching out.
    const bestEmail = personalEmail || workEmail || '';

    // 4. Duplicate check
    const existing = await storage.getUserCandidates(user.id);
    if (bestEmail) {
      const dupe = existing.find(c => c.email && c.email.toLowerCase() === bestEmail.toLowerCase());
      if (dupe) return res.status(409).json({ error: `${dupe.name} is already in your pipeline.` });
    }

    // 5. Save candidate
    const candidate = {
      id:          uuidv4(),
      userId:      user.id,
      name:        profile.name,
      email:       bestEmail,
      title:       profile.title       || '',
      company:     profile.company     || '',
      linkedin:    url                 || '',
      summary:     profile.summary     || '',
      background:  profile.summary     || '',
      phone:       '',
      career:      profile.career      || [],
      education:   profile.education   || [],
      stage:       'Imported',
      tags:        [],
      notes:       '',
      personalEmail,
      workEmail,
      emailSource,
      stepsCompleted: {},
      createdAt:   new Date().toISOString()
    };

    await storage.saveCandidate(candidate);

    return res.status(201).json({
      success:  true,
      name:     candidate.name,
      email:    candidate.email,
      company:  candidate.company,
      id:       candidate.id
    });
  } catch (err) {
    console.error('Quick-import error:', err);
    return res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

// CORS preflight for quick-import
router.options('/quick-import', (req, res) => {
  const origin = req.headers.origin || '';
  if (origin.startsWith('chrome-extension://')) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Extension-Token');
  }
  res.sendStatus(204);
});

// ── Auth-required routes ──────────────────────────────────────────────────
router.use(requireAuth);

// POST /api/linkedin/import
// Body: { url?, rawText? }
router.post('/import', async (req, res) => {
  try {
    const { url, rawText } = req.body;
    if (!url && !rawText) {
      return res.status(400).json({ error: 'Provide a LinkedIn URL or paste the profile text' });
    }

    const user = await storage.getUserById(req.session.userId);
    let profile = null;

    // 1. Try URL scraping
    if (url) profile = await linkedinSvc.scrapeFromUrl(url);

    // 2. Fall back to AI text parsing
    if ((!profile || !profile.name) && rawText) {
      profile = await linkedinSvc.parseFromText(rawText, url || '', user);
    }

    // 3. If URL provided but no raw text and scraping failed, ask for text
    if (!profile || !profile.name) {
      return res.status(422).json({
        needsText: true,
        error: 'LinkedIn blocked automatic import. Please copy the profile text and paste it below.'
      });
    }

    // 4. Enrich with email + phone via configured providers (ContactOut → Apollo → Hunter.io)
    const enriched = await linkedinSvc.enrichContact({
      name:            profile.name,
      company:         profile.company,
      linkedinUrl:     url || '',
      hunterApiKey:    user?.hunterApiKey    || '',
      contactOutApiKey: user?.contactOutApiKey || '',
      apolloApiKey:    user?.apolloApiKey    || ''
    });

    return res.json({
      ...profile,
      email:         enriched.email,
      personalEmail: enriched.personalEmail,
      workEmail:     enriched.workEmail,
      phone:         enriched.phone,
      emailSource:   enriched.source,
      linkedin:      url || ''
    });
  } catch (err) {
    console.error('LinkedIn import error:', err);
    return res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

module.exports = router;
