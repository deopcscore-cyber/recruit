const { DATA_DIR, BASE_URL, SESSION_SECRET, PORT, IS_PRODUCTION } = require('./config');

const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const path = require('path');
const fs = require('fs');

// ─── Startup diagnostics ──────────────────────────────────────────────────────
console.log('=== Welltower Recruiter starting ===');
console.log('NODE_ENV    :', process.env.NODE_ENV || '(not set)');
console.log('DATA_DIR    :', DATA_DIR);
console.log('BASE_URL    :', BASE_URL);
console.log('Persistent? :', process.env.DATA_DIR
  ? `YES — using DATA_DIR env var → ${DATA_DIR}`
  : `NO  — DATA_DIR env var not set; data stored in ephemeral container filesystem.
           On Railway: add Volume at /data and set DATA_DIR=/data to persist logins.`);

// Ensure required sub-directories exist
['sessions', 'resumes'].forEach(d => {
  const p = path.join(DATA_DIR, d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// ─── App ──────────────────────────────────────────────────────────────────────
const app = express();

// Trust Railway / Render / Heroku reverse proxy so secure cookies & req.ip work
app.set('trust proxy', 1);

app.use(session({
  store: new FileStore({
    path: path.join(DATA_DIR, 'sessions'),
    ttl: 604800,      // 7 days in seconds
    retries: 1,
    reapInterval: 3600
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,   // 7 days in ms
    httpOnly: true,
    sameSite: 'lax',
    // Only mark secure when actually running behind HTTPS proxy
    secure: IS_PRODUCTION
  }
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/candidates', require('./routes/candidates'));
app.use('/api/email',      require('./routes/email'));
app.use('/api/settings',   require('./routes/settings'));
app.use('/api/ai',         require('./routes/ai'));

// ─── Email open tracking pixel ────────────────────────────────────────────────
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

// ─── Gmail OAuth callback (root-level, not under /api/email) ─────────────────
const emailRoutes = require('./routes/email');
app.get('/auth/gmail/callback', emailRoutes.gmailCallback);

// ─── SPA catch-all ───────────────────────────────────────────────────────────
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Health check (Railway uses this) ────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', dataDir: DATA_DIR, persistent: !!process.env.DATA_DIR });
});

// ─── Listen ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Welltower Recruiter listening on port ${PORT}`);
  console.log(`DATA_DIR in use: ${DATA_DIR}`);

  // Verify we can write to DATA_DIR
  try {
    const testFile = path.join(DATA_DIR, '.write-test');
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    console.log('DATA_DIR write check: PASSED');
  } catch (err) {
    console.error('DATA_DIR write check: FAILED —', err.message);
    console.error('Users will not be able to register or log in!');
  }
});

module.exports = { app, DATA_DIR, BASE_URL };
