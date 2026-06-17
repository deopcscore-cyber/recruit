const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const storage = require('../services/storage');
const requireAuth = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const { ADMIN_EMAIL, BASE_URL } = require('../config');

// ── Password reset email sender ───────────────────────────────────────────────
// Uses SMTP env vars if set; falls back to the admin user's connected Gmail
// via the gmail service so no extra infrastructure is needed.
async function sendResetEmail(toEmail, resetUrl) {
  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (smtpHost && smtpUser && smtpPass) {
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: smtpUser, pass: smtpPass }
    });
    await transporter.sendMail({
      from: `"Recruit Pro" <${smtpUser}>`,
      to: toEmail,
      subject: 'Reset your Recruit Pro password',
      text: `Click the link below to reset your password. It expires in 1 hour.\n\n${resetUrl}\n\nIf you didn't request this, you can ignore this email.`,
      html: `<p>Click the link below to reset your Recruit Pro password. It expires in <strong>1 hour</strong>.</p><p><a href="${resetUrl}">${resetUrl}</a></p><p style="color:#888;font-size:12px">If you didn't request this, you can ignore this email.</p>`
    });
    return;
  }

  // Fallback: send via the admin user's connected Gmail
  if (ADMIN_EMAIL) {
    try {
      const gmailSvc = require('../services/gmail');
      const adminUser = await storage.getUserByEmail(ADMIN_EMAIL);
      if (adminUser && adminUser.gmail && adminUser.gmail.connected) {
        await gmailSvc.sendEmail(adminUser.id, {
          to: toEmail,
          subject: 'Reset your Recruit Pro password',
          body: `Click the link below to reset your password. It expires in 1 hour.\n\n${resetUrl}\n\nIf you didn't request this, you can ignore this email.`
        });
        return;
      }
    } catch (_) {}
  }

  throw new Error('No email provider configured. Ask your admin to set SMTP_HOST, SMTP_USER and SMTP_PASS in the environment variables.');
}

// Brute-force protection on credential endpoints
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many attempts — try again in a few minutes.' });

// Never send OAuth tokens to the browser — only connection status
function safeGmail(user) {
  return { connected: !!(user.gmail && user.gmail.connected), address: (user.gmail && user.gmail.address) || '' };
}

// POST /api/auth/register
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { name, email, password, userType } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    const VALID_TYPES = ['recruiter_company', 'recruiter_independent', 'career_consultant'];
    const resolvedType = VALID_TYPES.includes(userType) ? userType : 'recruiter_company';

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = await storage.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = {
      id: uuidv4(),
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password: passwordHash,
      userType: resolvedType,
      gmail: { connected: false, tokens: null, address: '' },
      style: { tone: 'warm', notes: '', use: [], avoid: [] },
      createdAt: new Date().toISOString()
    };

    await storage.saveUser(user);

    req.session.userId = user.id;
    req.session.userName = user.name;

    return res.status(201).json({
      id: user.id,
      name: user.name,
      email: user.email,
      gmail: safeGmail(user),
      style: user.style
    });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await storage.getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    req.session.userId = user.id;
    req.session.userName = user.name;

    return res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      gmail: safeGmail(user),
      style: user.style,
      userType: user.userType || 'recruiter_company',
      companyName: user.companyName || '',
      companyPitch: user.companyPitch || ''
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.clearCookie('connect.sid');
    return res.json({ success: true });
  });
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await storage.getUserById(req.session.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Auto-grant admin if ADMIN_EMAIL matches (self-healing — works on any request)
    if (ADMIN_EMAIL && user.email.toLowerCase() === ADMIN_EMAIL && !user.isAdmin) {
      user.isAdmin = true;
      await storage.saveUser(user);
      console.log(`Admin auto-granted to ${user.email} via /me`);
    }

    return res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      gmail: safeGmail(user),
      style: user.style,
      userType:    user.userType    || 'recruiter_company',
      companyName: user.companyName || '',
      companyPitch: user.companyPitch || '',
      isAdmin:  user.isAdmin  || false,
      credits:  user.credits  || 0,
      totalSpent: user.totalSpent || 0,
      resumeConsultantName:  user.resumeConsultantName  || '',
      resumeConsultantEmail: user.resumeConsultantEmail || '',
      tzOffset: (typeof user.tzOffset === 'number') ? user.tzOffset : null,
      emailNeedsReauth: !!(user.gmail && user.gmail.needsReauth)
    });
  } catch (err) {
    console.error('Get me error:', err);
    return res.status(500).json({ error: 'Failed to get user' });
  }
});

// POST /api/auth/forgot-password
const forgotLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: 'Too many reset attempts — try again later.' });
router.post('/forgot-password', forgotLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const user = await storage.getUserByEmail(email.toLowerCase().trim());
    // Always return success — don't reveal whether an account exists
    if (!user) return res.json({ success: true });

    const token   = crypto.randomBytes(32).toString('hex');
    const expiry  = Date.now() + 60 * 60 * 1000; // 1 hour
    user.resetToken       = token;
    user.resetTokenExpiry = expiry;
    await storage.saveUser(user);

    const resetUrl = `${BASE_URL}/login?reset=${token}`;
    await sendResetEmail(user.email, resetUrl);

    return res.json({ success: true });
  } catch (err) {
    console.error('Forgot-password error:', err);
    return res.status(500).json({ error: err.message || 'Failed to send reset email' });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const users = await storage.getAllUsers();
    const user  = users.find(u => u.resetToken === token);

    if (!user)                              return res.status(400).json({ error: 'Invalid or expired reset link' });
    if (!user.resetTokenExpiry || Date.now() > user.resetTokenExpiry)
                                            return res.status(400).json({ error: 'Reset link has expired — request a new one' });

    user.password          = await bcrypt.hash(password, 12);
    user.resetToken        = null;
    user.resetTokenExpiry  = null;
    await storage.saveUser(user);

    return res.json({ success: true });
  } catch (err) {
    console.error('Reset-password error:', err);
    return res.status(500).json({ error: 'Failed to reset password' });
  }
});

module.exports = router;
