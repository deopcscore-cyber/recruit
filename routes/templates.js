/* ============================================================
   Recruit Pro — Email Templates Routes
   Templates stored per user in user.templates[]
   ============================================================ */

const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const requireAuth = require('../middleware/auth');
const storage = require('../services/storage');

router.use(requireAuth);

// GET /api/templates
router.get('/', async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json(user.templates || []);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/templates
router.post('/', async (req, res) => {
  try {
    const { name, subject, body } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Template name is required' });
    if (!body || !body.trim()) return res.status(400).json({ error: 'Template body is required' });
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.templates) user.templates = [];
    const template = {
      id: uuidv4(),
      name: name.trim(),
      subject: (subject || '').trim(),
      body: body.trim(),
      createdAt: new Date().toISOString()
    };
    user.templates.push(template);
    await storage.saveUser(user);
    return res.status(201).json(template);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/templates/:id
router.put('/:id', async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const t = (user.templates || []).find(t => t.id === req.params.id);
    if (!t) return res.status(404).json({ error: 'Template not found' });
    if (req.body.name    !== undefined) t.name    = req.body.name.trim();
    if (req.body.subject !== undefined) t.subject = req.body.subject.trim();
    if (req.body.body    !== undefined) t.body    = req.body.body.trim();
    t.updatedAt = new Date().toISOString();
    await storage.saveUser(user);
    return res.json(t);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/templates/:id
router.delete('/:id', async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.templates = (user.templates || []).filter(t => t.id !== req.params.id);
    await storage.saveUser(user);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
