/* ============================================================
   Recruit Pro — LinkedIn Profile Import Routes
   ============================================================ */

const express    = require('express');
const router     = express.Router();
const requireAuth = require('../middleware/auth');
const linkedinSvc = require('../services/linkedin');
const storage    = require('../services/storage');

router.use(requireAuth);

// POST /api/linkedin/import
// Body: { url?, rawText? }
// Returns parsed profile fields ready to pre-fill the add-candidate form
router.post('/import', async (req, res) => {
  try {
    const { url, rawText } = req.body;
    if (!url && !rawText) {
      return res.status(400).json({ error: 'Provide a LinkedIn URL or paste the profile text' });
    }

    let profile = null;

    // 1. Try URL scraping
    if (url) {
      profile = await linkedinSvc.scrapeFromUrl(url);
    }

    // 2. If URL scraping failed and we have raw text, parse with Claude
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

    // 4. Optionally enrich with Hunter.io email finder
    let email = '';
    const user = await storage.getUserById(req.session.userId);
    if (user && user.hunterApiKey && profile.name && profile.company) {
      email = await linkedinSvc.findEmailViaHunter(profile.name, profile.company, user.hunterApiKey);
    }

    return res.json({ ...profile, email, linkedin: url || '' });
  } catch (err) {
    console.error('LinkedIn import error:', err);
    return res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

module.exports = router;
