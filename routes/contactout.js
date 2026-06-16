/* ============================================================
   Recruit Pro — ContactOut Bulk Import Route
   POST /api/contactout/bulk-import
   Called by the Chrome extension after scraping a ContactOut
   search results page. Auth via X-Extension-Token header.
   No Claude parsing needed — data is already structured from the DOM.
   ============================================================ */

const express  = require('express');
const router   = express.Router();
const { v4: uuidv4 } = require('uuid');
const storage  = require('../services/storage');
const rateLimit = require('../middleware/rateLimit');

// Extension token auth (same pattern as /api/linkedin/quick-import)
async function requireExtensionToken(req, res, next) {
  const token = req.headers['x-extension-token'];
  if (!token) return res.status(401).json({ error: 'Missing extension token. Open the extension popup and enter your token.' });

  const users = await storage.getAllUsers();
  const user  = users.find(u => u.extensionToken === token);
  if (!user) return res.status(401).json({ error: 'Invalid extension token. Copy it again from Settings → Account.' });

  req.importUser = user;
  next();
}

// CORS preflight for Chrome extension origin
router.options('/bulk-import', (req, res) => {
  const origin = req.headers.origin || '';
  if (origin.startsWith('chrome-extension://')) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Extension-Token');
  }
  res.sendStatus(204);
});

const bulkLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, message: 'Too many import requests — wait a minute.' });

// POST /api/contactout/bulk-import
router.post('/bulk-import', bulkLimiter, async (req, res) => {
  // CORS for Chrome extension
  const origin = req.headers.origin || '';
  if (origin.startsWith('chrome-extension://')) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Extension-Token');
  }

  // Auth
  const token = req.headers['x-extension-token'];
  if (!token) return res.status(401).json({ error: 'Missing extension token.' });

  let user;
  try {
    const users = await storage.getAllUsers();
    user = users.find(u => u.extensionToken === token);
    if (!user) return res.status(401).json({ error: 'Invalid extension token. Copy it again from Settings → Account.' });
  } catch (err) {
    return res.status(500).json({ error: 'Auth check failed.' });
  }

  const { candidates } = req.body;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return res.status(400).json({ error: 'No candidates provided.' });
  }
  if (candidates.length > 100) {
    return res.status(400).json({ error: 'Max 100 candidates per import.' });
  }

  let added   = 0;
  let skipped = 0;
  let failed  = 0;

  try {
    const existing = await storage.getUserCandidates(user.id);
    const existingEmails = new Set(
      existing.map(c => (c.email || '').toLowerCase()).filter(Boolean)
    );
    const existingLinkedins = new Set(
      existing.map(c => normalizeLinkedIn(c.linkedin)).filter(Boolean)
    );

    for (const raw of candidates) {
      try {
        if (!raw.name || raw.name.trim().length < 2) { failed++; continue; }

        const email = (raw.email || '').toLowerCase().trim();
        // Require a revealed email — don't import masked/empty profiles
        if (!email) { skipped++; continue; }
        const linkedin = normalizeLinkedIn(raw.linkedin);

        // Duplicate check — by email OR LinkedIn URL
        if (email && existingEmails.has(email)) { skipped++; continue; }
        if (linkedin && existingLinkedins.has(linkedin)) { skipped++; continue; }

        const PERSONAL_RE = /@(gmail|yahoo|hotmail|outlook|icloud|me|live|aol|protonmail|pm)\./i;
        const isPersonal  = email && PERSONAL_RE.test(email);

        const candidate = {
          id:           uuidv4(),
          userId:       user.id,
          name:         raw.name.trim(),
          email:        email,
          personalEmail: isPersonal ? email : '',
          workEmail:    !isPersonal && email ? email : '',
          emailSource:  email ? 'ContactOut (extension)' : '',
          phone:        (raw.phone || '').trim(),
          title:        (raw.title || '').trim(),
          company:      (raw.company || '').trim(),
          location:     (raw.location || '').trim(),
          linkedin:     raw.linkedin || '',
          summary:      '',
          background:   '',
          career:       Array.isArray(raw.career) ? raw.career : [],
          education:    [],
          stage:        'Imported',
          tags:         [],
          notes:        '',
          stepsCompleted: {},
          createdAt:    new Date().toISOString()
        };

        await storage.saveCandidate(candidate);

        // Track for intra-batch dedup
        if (email)    existingEmails.add(email);
        if (linkedin) existingLinkedins.add(linkedin);

        added++;
      } catch (innerErr) {
        console.error('ContactOut bulk-import: failed to save one candidate', innerErr);
        failed++;
      }
    }

    return res.status(201).json({ success: true, added, skipped, failed });

  } catch (err) {
    console.error('ContactOut bulk-import error:', err);
    return res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

function normalizeLinkedIn(url) {
  if (!url) return '';
  return url.replace(/\/$/, '').toLowerCase().split('?')[0];
}

module.exports = router;
