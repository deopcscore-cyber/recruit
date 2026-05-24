/* ============================================================
   Recruit Pro — LinkedIn Profile Import Routes
   ============================================================ */

const express    = require('express');
const router     = express.Router();
const crypto     = require('crypto');
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

// ── CORS preflight for bookmarklet (called from linkedin.com) ─────────────
router.options('/bookmarklet', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// POST /api/linkedin/bookmarklet  — called by the browser bookmarklet
// No session auth — the request comes from linkedin.com
router.post('/bookmarklet', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');

  const { url, text } = req.body;
  if (!text || text.trim().length < 50) {
    return res.status(400).json({ error: 'Profile text is too short — make sure you copied the full page.' });
  }
  try {
    const profile = await linkedinSvc.parseFromText(text, url || '');
    if (!profile || !profile.name) {
      return res.status(422).json({ error: 'Could not extract a name from the profile text. Try selecting more of the page.' });
    }
    // Note: bookmarklet has no user session, so no API-key enrichment here.
    // Enrichment happens when the user clicks "Add to Pipeline" in the dashboard
    // (the import modal calls /api/linkedin/import with the URL for enrichment).
    const token = crypto.randomBytes(10).toString('hex');
    cleanExpired();
    pendingImports.set(token, { profile: { ...profile, linkedin: url || '' }, expires: Date.now() + 10 * 60 * 1000 });
    return res.json({ token });
  } catch (err) {
    console.error('Bookmarklet parse error:', err);
    return res.status(500).json({ error: 'Parse failed: ' + err.message });
  }
});

// GET /api/linkedin/bookmarklet/:token  — dashboard retrieves the parsed profile
// No session auth — one-time token is the secret; expires in 10 min
router.get('/bookmarklet/:token', (req, res) => {
  cleanExpired();
  const entry = pendingImports.get(req.params.token);
  if (!entry) return res.status(404).json({ error: 'Import token not found or expired. Please run the bookmarklet again.' });
  pendingImports.delete(req.params.token); // one-time use
  return res.json(entry.profile);
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

    let profile = null;

    // 1. Try URL scraping
    if (url) profile = await linkedinSvc.scrapeFromUrl(url);

    // 2. Fall back to Claude text parsing
    if ((!profile || !profile.name) && rawText) {
      profile = await linkedinSvc.parseFromText(rawText, url || '');
    }

    // 3. If URL provided but no raw text and scraping failed, ask for text
    if (!profile || !profile.name) {
      return res.status(422).json({
        needsText: true,
        error: 'LinkedIn blocked automatic import. Please copy the profile text and paste it below.'
      });
    }

    // 4. Enrich with email + phone via configured providers (ContactOut → Apollo → Hunter.io)
    const user = await storage.getUserById(req.session.userId);
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
