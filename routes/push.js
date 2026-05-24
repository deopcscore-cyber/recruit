/* ============================================================
   Recruit Pro — Push Notification Routes
   ============================================================ */

const express = require('express');
const router  = express.Router();
const requireAuth = require('../middleware/auth');
const storage = require('../services/storage');
const { VAPID_PUBLIC } = require('../services/push');

router.use(requireAuth);

// GET /api/push/vapid-key — return public VAPID key for browser subscription
router.get('/vapid-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC || '' });
});

// POST /api/push/subscribe — save browser push subscription
router.post('/subscribe', async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription) return res.status(400).json({ error: 'subscription required' });
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.pushSubscription = subscription;
    await storage.saveUser(user);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/push/subscribe — remove subscription
router.delete('/subscribe', async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (user) { user.pushSubscription = null; await storage.saveUser(user); }
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
