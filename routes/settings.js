const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const storage = require('../services/storage');
const requireAuth = require('../middleware/auth');

// All routes require auth
router.use(requireAuth);

// GET /api/settings
router.get('/', async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({
      ...(user.style || { tone: 'warm', notes: '', use: [], avoid: [] }),
      name: user.name || '',
      title: user.title || ''
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

    const { tone, notes, use, avoid, name, title } = req.body;

    user.style = user.style || {};
    if (tone !== undefined) user.style.tone = tone;
    if (notes !== undefined) user.style.notes = notes;
    if (use !== undefined) user.style.use = Array.isArray(use) ? use : [];
    if (avoid !== undefined) user.style.avoid = Array.isArray(avoid) ? avoid : [];

    // Profile fields
    if (name && name.trim()) user.name = name.trim();
    if (title !== undefined) user.title = title.trim();

    await storage.saveUser(user);
    return res.json({
      ...user.style,
      name: user.name || '',
      title: user.title || ''
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

module.exports = router;
