/* ============================================================
   Recruit Pro — Admin API Routes
   ============================================================ */

const express    = require('express');
const router     = express.Router();
const storage    = require('../services/storage');
const requireAuth = require('../middleware/auth');

router.use(requireAuth);

// Must be admin
router.use(async (req, res, next) => {
  const user = await storage.getUserById(req.session.userId);
  if (!user?.isAdmin) return res.status(403).json({ error: 'Admin access required' });
  next();
});

// GET /api/admin/users
router.get('/users', async (req, res) => {
  try {
    const [users, candidates] = await Promise.all([
      storage.getAllUsers(),
      storage.getAllCandidates()
    ]);

    const result = users.map(u => ({
      id:             u.id,
      name:           u.name           || '',
      email:          u.email          || '',
      userType:       u.userType       || 'recruiter_company',
      credits:        u.credits        || 0,    // in cents
      totalSpent:     u.totalSpent     || 0,    // in cents
      isAdmin:        u.isAdmin        || false,
      emailType:      u.outlook?.connected ? 'Outlook'
                    : u.zoho?.connected    ? 'Zoho'
                    : u.gmail?.connected   ? 'Gmail' : 'None',
      candidateCount: candidates.filter(c => c.userId === u.id).length,
      createdAt:      u.createdAt      || '',
      lastActive:     u.lastActive     || ''
    }));

    res.json({ users: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/users/:id/credits  { amount: <cents integer> }
router.post('/users/:id/credits', async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount)) return res.status(400).json({ error: 'amount in cents (integer) required' });

    const user = await storage.getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.credits = Math.max(0, (user.credits || 0) + Math.round(amount));
    await storage.saveUser(user);

    res.json({ id: user.id, name: user.name, credits: user.credits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/users/:id  — update isAdmin flag
router.put('/users/:id', async (req, res) => {
  try {
    const user = await storage.getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (typeof req.body.isAdmin === 'boolean') {
      // Prevent removing your own admin
      if (user.id === req.session.userId && !req.body.isAdmin) {
        return res.status(400).json({ error: 'Cannot remove your own admin access' });
      }
      user.isAdmin = req.body.isAdmin;
    }
    await storage.saveUser(user);
    res.json({ id: user.id, isAdmin: user.isAdmin });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', async (req, res) => {
  try {
    if (req.params.id === req.session.userId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    const users = await storage.getAllUsers();
    const filtered = users.filter(u => u.id !== req.params.id);
    if (filtered.length === users.length) return res.status(404).json({ error: 'User not found' });
    await storage.saveAllUsers(filtered);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
