require('dotenv').config();
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const path = require('path');
const fs = require('fs');

const app = express();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// Ensure directories exist
['sessions', 'resumes'].forEach(d => {
  const p = path.join(DATA_DIR, d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

app.use(session({
  store: new FileStore({ path: path.join(DATA_DIR, 'sessions'), ttl: 604800, retries: 0 }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/candidates', require('./routes/candidates'));
app.use('/api/email', require('./routes/email'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/ai', require('./routes/ai'));

// Tracking pixel
const BLANK_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
app.get('/track/:trackingId', async (req, res) => {
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' });
  try {
    const storage = require('./services/storage');
    const candidates = await storage.getAllCandidates();
    const candidate = candidates.find(c => c.trackingId === req.params.trackingId);
    if (candidate && !candidate.opened) {
      candidate.opened = true;
      candidate.openedAt = new Date().toISOString();
      await storage.saveAllCandidates(candidates);
    }
  } catch (err) {
    console.error('Tracking error:', err.message);
  }
  res.send(BLANK_GIF);
});

// Gmail OAuth callback lives at root level
const emailRoutes = require('./routes/email');
app.get('/auth/gmail/callback', emailRoutes.gmailCallback);

app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Welltower Recruiter on http://localhost:${PORT}`));

module.exports = { app, DATA_DIR, BASE_URL };
