const { DATA_DIR, BASE_URL, SESSION_SECRET, PORT, IS_PRODUCTION, ADMIN_EMAIL } = require('./config');

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
['sessions', 'resumes', 'photos'].forEach(d => {
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

// Baseline security headers (CSP omitted — the dashboard relies on inline scripts/styles)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// 2mb is plenty for JSON payloads (LinkedIn profile text, threads); uploads go
// through multer on their own routes with their own limits.
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    // Never let browsers cache JS/CSS — stale assets cause silent UI bugs after deploys
    if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Serve uploaded profile photos publicly
app.use('/photos', express.static(path.join(DATA_DIR, 'photos'), { maxAge: '7d' }));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/candidates', require('./routes/candidates'));
app.use('/api/email',      require('./routes/email'));
app.use('/api/settings',   require('./routes/settings'));
app.use('/api/ai',         require('./routes/ai'));
app.use('/api/analytics',  require('./routes/analytics'));
app.use('/api/queue',      require('./routes/queue'));
app.use('/api/push',       require('./routes/push'));
app.use('/api/templates',  require('./routes/templates'));
app.use('/api/linkedin',   require('./routes/linkedin'));
app.use('/api/contactout', require('./routes/contactout'));
app.use('/api/admin',      require('./routes/admin'));

// ─── Admin bootstrap — grant admin to the logged-in user if they match ADMIN_EMAIL ──
// Hit this once after setting ADMIN_EMAIL env var. No-op once already admin.
app.post('/api/admin/bootstrap', require('./middleware/auth'), async (req, res) => {
  try {
    const storageService = require('./services/storage');
    const user = await storageService.getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!ADMIN_EMAIL) return res.status(400).json({ error: 'ADMIN_EMAIL env var not set on server' });
    if (user.email.toLowerCase() !== ADMIN_EMAIL) {
      return res.status(403).json({ error: `This account (${user.email}) does not match ADMIN_EMAIL` });
    }
    user.isAdmin = true;
    await storageService.saveUser(user);
    console.log(`Admin bootstrapped for: ${user.email}`);
    res.json({ success: true, message: `Admin granted to ${user.email}. Refresh the page.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Email open tracking pixel ────────────────────────────────────────────────
const rateLimit = require('./middleware/rateLimit');
const BLANK_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const pushSvc = require('./services/push');
app.get('/track/:trackingId', rateLimit({ windowMs: 60 * 1000, max: 120 }), async (req, res) => {
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' });
  try {
    const storage = require('./services/storage');
    const candidates = await storage.getAllCandidates();
    const candidate = candidates.find(c => c.trackingId === req.params.trackingId);
    if (candidate && !candidate.opened) {
      candidate.opened = true;
      candidate.openedAt = new Date().toISOString();
      await storage.saveAllCandidates(candidates);
      // Fire push notification to recruiter
      pushSvc.sendNotification(candidate.userId, {
        title: '📬 Email Opened',
        body: `${candidate.name} just opened your email`,
        tag: `opened-${candidate.id}`,
        url: '/dashboard'
      }).catch(() => {});
    }
  } catch (err) {
    console.error('Tracking error:', err.message);
  }
  res.send(BLANK_GIF);
});

// ─── Gmail OAuth callback ─────────────────────────────────────────────────────
const emailRoutes = require('./routes/email');
app.get('/auth/gmail/callback', emailRoutes.gmailCallback);

// ─── Zoho OAuth callback ──────────────────────────────────────────────────────
// Identity comes from the session; `state` must match the nonce issued at the
// start of the flow. Never derive the user from the state parameter.
const zohoService = require('./services/zoho');
app.get('/auth/zoho/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) return res.redirect('/dashboard?zoho=error&reason=' + encodeURIComponent(error || 'no_code'));
  const userId = req.session && req.session.userId;
  if (!userId) return res.redirect('/login?zoho=error&reason=session_expired');
  if (!state || state !== req.session.oauthState) {
    return res.redirect('/dashboard?zoho=error&reason=state_mismatch');
  }
  delete req.session.oauthState;
  try {
    await zohoService.exchangeCode(userId, code);
    return res.redirect('/dashboard?zoho=connected');
  } catch (err) {
    console.error('Zoho callback error:', err);
    return res.redirect('/dashboard?zoho=error&reason=' + encodeURIComponent(err.message));
  }
});

// ─── Outlook (Microsoft) OAuth callback ──────────────────────────────────────
const outlookService = require('./services/outlook');
app.get('/auth/outlook/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) return res.redirect('/dashboard?outlook=error&reason=' + encodeURIComponent(error || 'no_code'));
  const userId = req.session && req.session.userId;
  if (!userId) return res.redirect('/login?outlook=error&reason=session_expired');
  if (!state || state !== req.session.oauthState) {
    return res.redirect('/dashboard?outlook=error&reason=state_mismatch');
  }
  delete req.session.oauthState;
  try {
    await outlookService.exchangeCode(userId, code);
    return res.redirect('/dashboard?outlook=connected');
  } catch (err) {
    console.error('Outlook callback error:', err);
    return res.redirect('/dashboard?outlook=error&reason=' + encodeURIComponent(err.message));
  }
});

// ─── Chrome extension download ────────────────────────────────────────────────
// GET /extension/download — builds a zip of extension/ on the fly using only
// Node built-ins (no archiver dep). Auth-protected.
const requireAuth = require('./middleware/auth');

app.get('/extension/download', requireAuth, (req, res) => {
  const extDir = path.join(__dirname, 'extension');
  if (!fs.existsSync(extDir)) return res.status(404).json({ error: 'Extension not found' });

  try {
    const zip = buildZip(extDir, 'recruit-pro-extension');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="recruit-pro-extension.zip"');
    res.send(zip);
  } catch (err) {
    console.error('Extension zip error:', err);
    res.status(500).json({ error: 'Failed to build extension zip' });
  }
});

// Pure-Node ZIP builder — no dependencies.
// Supports flat files and one level of subdirectories.
function buildZip (dir, rootName) {
  const zlib = require('zlib');
  const entries = [];

  function addDir (absDir, zipDir) {
    for (const name of fs.readdirSync(absDir)) {
      const abs  = path.join(absDir, name);
      const zip  = zipDir ? `${zipDir}/${name}` : name;
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        addDir(abs, zip);
      } else {
        entries.push({ name: zip, data: fs.readFileSync(abs) });
      }
    }
  }
  addDir(dir, rootName);

  // Build ZIP: Local File Headers + data, then Central Directory + EOCD
  const localHeaders = [];
  let offset = 0;

  const parts = entries.map(({ name, data }) => {
    const deflated   = zlib.deflateRawSync(data, { level: 6 });
    const useDef     = deflated.length < data.length;
    const fileData   = useDef ? deflated : data;
    const method     = useDef ? 8 : 0;
    const nameBytes  = Buffer.from(name, 'utf8');
    const crc        = crc32(data);
    const now        = new Date();
    const dosTime    = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate    = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);       // signature
    local.writeUInt16LE(20, 4);               // version needed
    local.writeUInt16LE(0, 6);                // flags
    local.writeUInt16LE(method, 8);           // compression
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);             // CRC-32
    local.writeUInt32LE(fileData.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22);     // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);               // extra field length
    nameBytes.copy(local, 30);

    localHeaders.push({ name, nameBytes, method, crc, compSize: fileData.length, uncompSize: data.length, dosTime, dosDate, offset });
    offset += local.length + fileData.length;

    return Buffer.concat([local, fileData]);
  });

  const centralParts = localHeaders.map(h => {
    const cd = Buffer.alloc(46 + h.nameBytes.length);
    cd.writeUInt32LE(0x02014b50, 0);        // central dir signature
    cd.writeUInt16LE(20, 4);               // version made by
    cd.writeUInt16LE(20, 6);               // version needed
    cd.writeUInt16LE(0, 8);               // flags
    cd.writeUInt16LE(h.method, 10);
    cd.writeUInt16LE(h.dosTime, 12);
    cd.writeUInt16LE(h.dosDate, 14);
    cd.writeUInt32LE(h.crc, 16);
    cd.writeUInt32LE(h.compSize, 20);
    cd.writeUInt32LE(h.uncompSize, 24);
    cd.writeUInt16LE(h.nameBytes.length, 28);
    cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); // extra, comment
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); // disk start, int attr
    cd.writeUInt32LE(0, 38);               // ext attr
    cd.writeUInt32LE(h.offset, 42);        // local header offset
    h.nameBytes.copy(cd, 46);
    return cd;
  });

  const centralBuf  = Buffer.concat(centralParts);
  const cdOffset    = offset;
  const eocd        = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, centralBuf, eocd]);
}

// CRC-32 implementation (no deps)
function crc32 (buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ─── SPA catch-all ───────────────────────────────────────────────────────────
const NO_CACHE = { 'Cache-Control': 'no-cache, no-store, must-revalidate', Pragma: 'no-cache', Expires: '0' };
app.get('/dashboard',  (req, res) => { res.set(NO_CACHE); res.sendFile(path.join(__dirname, 'public', 'dashboard.html')); });
app.get('/admin',      (req, res) => { res.set(NO_CACHE); res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.get('/li-capture', (req, res) => { res.set(NO_CACHE); res.sendFile(path.join(__dirname, 'public', 'li-capture.html')); });
app.get('/login',      (req, res) => { res.set(NO_CACHE); res.sendFile(path.join(__dirname, 'public', 'login.html')); });
app.get('/',           (req, res) => { res.set(NO_CACHE); res.sendFile(path.join(__dirname, 'public', 'landing.html')); });

// ─── Health check (Railway uses this) ────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', dataDir: DATA_DIR, persistent: !!process.env.DATA_DIR });
});

// ─── Listen ───────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
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

  // Auto-grant admin to ADMIN_EMAIL if set
  if (ADMIN_EMAIL) {
    try {
      const storageService = require('./services/storage');
      const adminUser = await storageService.getUserByEmail(ADMIN_EMAIL);
      if (adminUser && !adminUser.isAdmin) {
        adminUser.isAdmin = true;
        await storageService.saveUser(adminUser);
        console.log(`Admin granted to: ${ADMIN_EMAIL}`);
      } else if (adminUser) {
        console.log(`Admin already set: ${ADMIN_EMAIL}`);
      } else {
        console.log(`ADMIN_EMAIL set to ${ADMIN_EMAIL} but no matching account found yet`);
      }
    } catch (e) {
      console.error('Admin init error:', e.message);
    }
  }
});

// ─── Bulk outreach queue processor ───────────────────────────────────────────
const queueSvc      = require('./services/queue');
const claudeSvc     = require('./services/claude');
const gmailSvc2     = require('./services/gmail');
const zohoSvc2      = require('./services/zoho');
const outlookSvc2   = require('./services/outlook');
const { v4: queueUuid } = require('uuid');

// Provider helpers (mirrors routes/email.js dispatcher)
function _isZohoOAuthReady(user) {
  return !!(user.zoho?.connected && user.zoho.accessToken);
}
function _isOutlookReady(user) {
  return !!(user.outlook?.connected && user.outlook.accessToken);
}
function _getEmailService(user) {
  if (_isOutlookReady(user))  return outlookSvc2;
  if (_isZohoOAuthReady(user)) return zohoSvc2;
  return gmailSvc2;
}
function _isEmailConnected(user) {
  return !!(user.gmail?.connected) || _isZohoOAuthReady(user) || _isOutlookReady(user);
}
function _getUserEmailAddress(user) {
  if (_isOutlookReady(user) && user.outlook.address) return user.outlook.address;
  if (_isZohoOAuthReady(user) && user.zoho.address)  return user.zoho.address;
  return (user.gmail && user.gmail.address) || null;
}

const followupsSvc = require('./services/followups');
let queueBusy = false;

// Gmail's own per-user quota (not something we control) returns
// "User-rate limit exceeded.  Retry after 2026-07-12T20:33:05.301Z" — a
// transient condition that resolves itself. Extracts the retry time so
// callers can reschedule instead of treating it as a permanent failure.
function _gmailRateLimitRetryAt(err) {
  const msg = (err && err.message) || '';
  if (!/rate limit exceeded/i.test(msg)) return null;
  const match = msg.match(/Retry after (\S+)/i);
  const parsed = match ? new Date(match[1]) : null;
  if (parsed && !isNaN(parsed)) return parsed;
  return new Date(Date.now() + 15 * 60 * 1000); // no timestamp given — fall back to 15 min
}

async function processQueueJob() {
  if (queueBusy) return;
  const job = queueSvc.getNextDueJob();
  if (!job) return;

  queueBusy = true;
  queueSvc.updateJob(job.id, { status: 'sending' });

  try {
    if ((job.type || 'outreach') === 'followup') {
      await _processFollowUpJob(job);
    } else if (job.type === 'scheduled_send') {
      await _processScheduledSendJob(job);
    } else {
      await _processOutreachJob(job);
    }
  } catch (err) {
    const retryAt = _gmailRateLimitRetryAt(err);
    if (retryAt) {
      // Transient Gmail quota — push back to pending at the retry time instead
      // of losing the send. Otherwise this silently drops outreach/follow-ups
      // with no way for the user to know it never went out.
      queueSvc.updateJob(job.id, { status: 'pending', scheduledAt: retryAt.toISOString() });
      console.log(`Queue job ${job.id} hit Gmail rate limit — rescheduled for ${retryAt.toISOString()}`);
    } else {
      console.error(`Queue job ${job.id} failed: ${err.message}`);
      queueSvc.updateJob(job.id, { status: 'failed', error: err.message });
      // A permanently-failed job never gets another shot at using the
      // recruiter's uploaded file — the periodic sweep would eventually
      // catch it, but there's no reason to wait.
      if (job.customAttachmentId) {
        try { require('./services/outbound').deleteCustomAttachment(job.customAttachmentId); } catch { /* best-effort */ }
      }
    }
  } finally {
    queueBusy = false;
  }
}

async function _processOutreachJob(job) {
  const storageSvc = require('./services/storage');
  const user      = await storageSvc.getUserById(job.userId);
  const candidate = await storageSvc.getCandidateById(job.candidateId);

  if (!user || !candidate) throw new Error('User or candidate not found');
  if (!_isEmailConnected(user)) throw new Error('No email provider connected');
  if ((user.credits || 0) <= 0) throw new Error('Insufficient credits');

  // For autopilot jobs, enforce the send window — reschedule if we're outside it
  if (job.source === 'autopilot' && user.autopilot) {
    const { windowBounds } = require('./services/autopilot');
    const schedulingSvc = require('./services/scheduling');
    const offset = schedulingSvc.userOffset(user);
    const { startMs, endMs } = windowBounds(user.autopilot, new Date(), offset);
    const now = Date.now();
    if (now < startMs || now > endMs) {
      // Outside window — push to next window start instead of sending now
      queueSvc.updateJob(job.id, { status: 'pending', scheduledAt: new Date(startMs).toISOString() });
      return;
    }
  }

  // Generate personalised outreach (deduct credits)
  const outreachResult = await claudeSvc.generateOutreach(candidate, user);
  const draft = outreachResult.text;
  // Consultant outreach returns its own subject; otherwise use the queued
  // subject, then a sensible personalised default.
  const firstName = (candidate.name || '').trim().split(/\s+/)[0] || 'there';
  const subject = outreachResult.subject || job.subject ||
    `A quick note for you, ${firstName}`;
  if (outreachResult.costCents) {
    user.credits    = Math.max(0, (user.credits    || 0) - outreachResult.costCents);
    user.totalSpent = (user.totalSpent || 0) + outreachResult.costCents;
    await storageSvc.saveUser(user);
  }

  // Fresh tracking pixel — resets opened badge for this new email
  const { v4: queueUuidV4 } = require('uuid');
  candidate.trackingId = queueUuidV4();
  candidate.opened     = false;
  candidate.openedAt   = null;

  const emailSvc = _getEmailService(user);
  const { gmailMessageId, gmailThreadId, smtpMessageId } =
    await emailSvc.sendEmail(job.userId, {
      to:      candidate.email,
      subject,
      body:    draft,
      trackingId: candidate.trackingId
    });

  const msg = {
    id: queueUuid(), direction: 'outbound',
    subject, body: draft,
    timestamp: new Date().toISOString(),
    gmailMessageId, gmailThreadId, smtpMessageId, read: true
  };
  if (!candidate.thread) candidate.thread = [];
  candidate.thread.push(msg);
  candidate.lastGmailMessageId = gmailMessageId;
  candidate.lastSmtpMessageId  = smtpMessageId;
  candidate.lastSubject        = subject;
  candidate.stepsCompleted     = { ...(candidate.stepsCompleted || {}), outreach: true };
  candidate.stage              = 'Outreach Sent';
  if (!candidate.gmailThreadId)  candidate.gmailThreadId  = gmailThreadId;
  if (!candidate.originalSubject) candidate.originalSubject = subject;
  if (smtpMessageId) {
    const newRef = `<${smtpMessageId.replace(/^<|>$/g, '')}>`;
    candidate.gmailReferences = candidate.gmailReferences
      ? `${candidate.gmailReferences} ${newRef}` : newRef;
    candidate.lastSmtpMessageId = smtpMessageId;
  }
  await storageSvc.saveCandidate(candidate);

  // Kick off the automated follow-up sequence for this candidate
  try { followupsSvc.scheduleSequence(user, candidate); } catch (e) { console.error('Follow-up schedule error:', e.message); }

  queueSvc.updateJob(job.id, { status: 'sent', sentAt: new Date().toISOString() });
  console.log(`Queue: outreach sent → ${candidate.name} <${candidate.email}>`);
}

// User-composed draft queued via schedule-send. No AI generation and no credit
// spend at send time — the exact approved text goes out through the same path
// as an immediate manual send.
async function _processScheduledSendJob(job) {
  const storageSvc = require('./services/storage');
  const outbound   = require('./services/outbound');
  const user      = await storageSvc.getUserById(job.userId);
  const candidate = await storageSvc.getCandidateById(job.candidateId);

  if (!user || !candidate) { queueSvc.updateJob(job.id, { status: 'cancelled', reason: 'missing' }); return; }
  if (!outbound.isEmailConnected(user)) throw new Error('No email provider connected');

  // Role JD sends carry either structured AI variant data or a recruiter's
  // uploaded edited DOCX (resolveRoleJDAttachment prefers the upload). Let a
  // build failure propagate — an email promising an attached role description
  // that silently has none is worse than a job the user can see failed and retry.
  let attachments = null;
  const att = await outbound.resolveRoleJDAttachment(candidate, user, {
    roleJDVariants: job.roleJDVariants, jdLocation: job.jdLocation,
    customAttachmentId: job.customAttachmentId, customAttachmentFilename: job.customAttachmentFilename
  });
  if (att) attachments = [att];

  await outbound.sendComposed(user, candidate, {
    subject: job.subject,
    body:    job.body,
    isReply: !!job.isReply,
    isFollowUp: !!job.isFollowUp,
    cc:      job.cc || null,
    attachments
  });

  if (job.customAttachmentId) outbound.deleteCustomAttachment(job.customAttachmentId);

  queueSvc.updateJob(job.id, { status: 'sent', sentAt: new Date().toISOString() });
  console.log(`Queue: scheduled send delivered → ${candidate.name} <${candidate.email}>`);
}

// Generate the right follow-up content for a job, based on its kind. review/
// victory use their own dedicated (draft-only) generators; everything else
// (outreach, roleJD, resumeRequested) shares generateFollowUp's scenario
// branching, keyed by kind + which step in the sequence this is.
async function _generateFollowUpContent(job, candidate, user) {
  const kind = job.followUpKind || 'outreach';
  if (kind === 'review')  return claudeSvc.generateReviewFollowUp(candidate, user);
  if (kind === 'victory') return claudeSvc.generateVictoryFollowUp(candidate, user);
  return claudeSvc.generateFollowUp(candidate, user, undefined, kind, job.followUpIndex || 0);
}

async function _processFollowUpJob(job) {
  const storageSvc = require('./services/storage');
  const user      = await storageSvc.getUserById(job.userId);
  const candidate = await storageSvc.getCandidateById(job.candidateId);

  if (!user || !candidate) { queueSvc.updateJob(job.id, { status: 'cancelled', reason: 'missing' }); return; }

  if (candidate.bounced) {
    queueSvc.updateJob(job.id, { status: 'cancelled', reason: 'bounced' });
    console.log(`Queue: follow-up skipped (bounced) → ${candidate.name}`);
    return;
  }
  if (candidate.stage === 'Closed') {
    queueSvc.updateJob(job.id, { status: 'cancelled', reason: 'closed' });
    return;
  }
  // Cancel only if they replied SINCE this specific touchpoint went out — not
  // "have they ever replied." Every candidate past Outreach Sent has already
  // replied at least once by definition, so an "ever replied" check would
  // immediately cancel every later-stage sequence (roleJD, resumeRequested,
  // review, victory) the moment it's scheduled.
  const sinceMs = job.sinceTimestamp ? new Date(job.sinceTimestamp).getTime() : 0;
  const repliedSince = (candidate.thread || []).some(m =>
    m.direction === 'inbound' && new Date(m.timestamp).getTime() > sinceMs);
  if (repliedSince) {
    queueSvc.updateJob(job.id, { status: 'cancelled', reason: 'candidate_responded' });
    console.log(`Queue: follow-up skipped (candidate responded) → ${candidate.name}`);
    return;
  }

  const mode = job.mode || 'auto';

  if (mode === 'draft') {
    // Generate and save as a pending draft for the recruiter to review — never
    // auto-sent. Used for later, higher-stakes touchpoints (review, victory).
    if ((user.credits || 0) <= 0) throw new Error('Insufficient credits');
    const result = await _generateFollowUpContent(job, candidate, user);
    if (result.costCents) {
      user.credits    = Math.max(0, (user.credits    || 0) - result.costCents);
      user.totalSpent = (user.totalSpent || 0) + result.costCents;
      await storageSvc.saveUser(user);
    }
    const subject = candidate.originalSubject
      ? 'Re: ' + candidate.originalSubject.replace(/^re:\s*/i, '')
      : (candidate.lastSubject || 'Following up');
    candidate.pendingFollowUpDraft = {
      kind: job.followUpKind, subject, body: result.text, createdAt: new Date().toISOString()
    };
    await storageSvc.saveCandidate(candidate);
    pushSvc.sendNotification(user.id, {
      title: '✍️ Follow-up draft ready',
      body: `A follow-up for ${candidate.name} is ready to review`,
      tag: `followup-draft-${candidate.id}`,
      url: '/dashboard'
    }).catch(() => {});
    queueSvc.updateJob(job.id, { status: 'sent', sentAt: new Date().toISOString(), reason: 'drafted' });
    console.log(`Queue: follow-up draft ready (${job.followUpKind}) → ${candidate.name}`);
    return;
  }

  // mode === 'auto' — generate and send immediately, no review
  if (!_isEmailConnected(user)) throw new Error('No email provider connected');
  if ((user.credits || 0) <= 0) throw new Error('Insufficient credits');

  const result = await _generateFollowUpContent(job, candidate, user);
  const draft = result.text;
  if (result.costCents) {
    user.credits    = Math.max(0, (user.credits    || 0) - result.costCents);
    user.totalSpent = (user.totalSpent || 0) + result.costCents;
    await storageSvc.saveUser(user);
  }

  // Send as a reply in the existing thread so it lands in the same conversation
  const subject = candidate.originalSubject
    ? 'Re: ' + candidate.originalSubject.replace(/^re:\s*/i, '')
    : (candidate.lastSubject || 'Following up');
  const sendParams = {
    to: candidate.email, subject, body: draft, trackingId: candidate.trackingId
  };
  if (candidate.gmailThreadId)     sendParams.threadId  = candidate.gmailThreadId;
  if (candidate.lastSmtpMessageId) {
    sendParams.inReplyTo  = candidate.lastSmtpMessageId.replace(/^<|>$/g, '');
    sendParams.references = candidate.gmailReferences || '';
  }

  const emailSvc = _getEmailService(user);
  const { gmailMessageId, gmailThreadId, smtpMessageId } = await emailSvc.sendEmail(job.userId, sendParams);

  candidate.thread = candidate.thread || [];
  candidate.thread.push({
    id: queueUuid(), direction: 'outbound', subject, body: draft,
    timestamp: new Date().toISOString(), gmailMessageId, gmailThreadId, smtpMessageId,
    read: true, isFollowUp: true, followUpIndex: job.followUpIndex, followUpKind: job.followUpKind || 'outreach'
  });
  candidate.lastGmailMessageId = gmailMessageId;
  if (smtpMessageId) {
    candidate.lastSmtpMessageId = smtpMessageId;
    const newRef = `<${smtpMessageId.replace(/^<|>$/g, '')}>`;
    candidate.gmailReferences = candidate.gmailReferences
      ? `${candidate.gmailReferences} ${newRef}` : newRef;
  }
  await storageSvc.saveCandidate(candidate);

  queueSvc.updateJob(job.id, { status: 'sent', sentAt: new Date().toISOString() });
  console.log(`Queue: follow-up #${(job.followUpIndex || 0) + 1} (${job.followUpKind || 'outreach'}) sent → ${candidate.name}`);
}

queueSvc.resetStuckJobs(); // recover any jobs frozen mid-send by a server crash

// Check for due jobs every 30 seconds
setInterval(processQueueJob, 30 * 1000);
// Prune old completed jobs every 6 hours
setInterval(() => queueSvc.pruneOld(), 6 * 60 * 60 * 1000);
// Safety-net sweep for role-JD edits uploaded but never sent (closed tab,
// abandoned draft) — normal cleanup happens at send/cancel/failure time.
setInterval(() => require('./services/outbound').pruneOldCustomAttachments(), 6 * 60 * 60 * 1000);

// ─── Daily auto-outreach (Autopilot) ─────────────────────────────────────────
// Every 15 min, for each user with autopilot on, schedule today's drip batch
// once (the planner self-guards to once-per-day inside the send window).
const autopilotSvc = require('./services/autopilot');
async function runAutopilot() {
  try {
    const storageSvc = require('./services/storage');
    const users = await storageSvc.getAllUsers();
    for (const user of users) {
      try {
        if (!user.autopilot || !user.autopilot.enabled) continue;
        if (!_isEmailConnected(user)) continue;
        if ((user.credits || 0) <= 0) continue;

        const candidates = await storageSvc.getUserCandidates(user.id);
        const plan = autopilotSvc.planDailyRun(user, candidates, new Date());
        if (!plan.ran) continue;

        if (plan.jobs && plan.jobs.length) queueSvc.addJobs(plan.jobs);

        // Persist the once-per-day marker so we don't re-run today
        user.autopilot = { ...user.autopilot, lastRunDate: plan.lastRunDate };
        await storageSvc.saveUser(user);

        if (plan.count > 0) {
          console.log(`Autopilot: queued ${plan.count} outreach for ${user.email} (cap ${plan.effectiveCap}, ${plan.eligibleTotal} eligible)`);
        }
      } catch (uErr) {
        console.error(`Autopilot error for user ${user.id}:`, uErr.message);
      }
    }
  } catch (err) {
    console.error('Autopilot global error:', err.message);
  }
}
// First pass 90s after boot, then every 15 minutes
setTimeout(() => { runAutopilot(); setInterval(runAutopilot, 15 * 60 * 1000); }, 90 * 1000);

// ─── Auto-fetch emails every 10 minutes ──────────────────────────────────────
const AUTO_FETCH_MS = 10 * 60 * 1000;

async function runAutoFetch() {
  try {
    const storageService = require('./services/storage');

    const users = await storageService.getAllUsers();
    for (const user of users) {
      if (!_isEmailConnected(user)) continue;
      try {
        const svc = _getEmailService(user);

        // Build candidate context BEFORE calling fetch so Gmail can search
        // the right threads and email addresses (without these it returns nothing)
        const candidates = await storageService.getUserCandidates(user.id);
        const candidateEmails    = candidates.map(c => c.email).filter(Boolean);
        const candidateThreadIds = {};
        candidates.forEach(c => { if (c.gmailThreadId) candidateThreadIds[c.gmailThreadId] = c.id; });

        // Zoho ignores the extra args; Gmail requires them
        const replies = await svc.fetchUnreadReplies(user.id, candidateEmails, candidateThreadIds);
        if (!replies.length) continue;
        const stageOrder = ['Imported','Outreach Sent','Replied','Resume Requested','Resume Received','Interviewing','Closed'];
        let matched = 0;

        for (const reply of replies) {
          const fromEmail = reply.from ? (reply.from.match(/<([^>]+)>/) || [,''])[1].trim() || reply.from.trim() : '';

          // Match candidate: thread ID first (bounce-backs arrive in the same
          // Gmail thread as the original send, from mailer-daemon — not the
          // candidate's own address, so from-email matching alone misses them
          // entirely and bounces never get flagged), then from-email, then
          // tracking pixel in the body.
          let candidate = null;
          if (reply.matchedCandidateId) {
            candidate = candidates.find(c => c.id === reply.matchedCandidateId);
          }
          if (!candidate && fromEmail) {
            candidate = candidates.find(c => c.email && c.email.toLowerCase() === fromEmail.toLowerCase());
          }
          if (!candidate && reply.body) {
            candidate = candidates.find(c => c.trackingId && reply.body.includes(`/track/${c.trackingId}`));
          }
          if (!candidate) continue;

          // Bounce detection — sender is MAILER-DAEMON/postmaster, or subject signals NDR
          const fromAddrLower = (reply.from || '').toLowerCase();
          const subjLower     = (reply.subject || '').toLowerCase();
          const isBounce = /mailer-daemon|postmaster@|mail delivery subsystem|delivery subsystem/i.test(fromAddrLower)
            || /undeliverable|delivery (has )?fail|delivery status notification|returned mail|address not found|user unknown|no such user/i.test(subjLower);
          if (isBounce) {
            candidate.bounced   = true;
            candidate.bouncedAt = new Date().toISOString();
            await storageService.saveCandidate(candidate);
            try { followupsSvc.cancelSequence(candidate.id); } catch (e) {}
            console.log(`Auto-fetch: bounce detected for ${candidate.name} <${candidate.email}> — follow-ups cancelled`);
            continue;
          }

          const already = (candidate.thread || []).some(t => t.gmailMessageId === reply.gmailMessageId);
          if (already) continue;

          const msg = {
            id: require('uuid').v4(),
            direction: 'inbound',
            subject: reply.subject || candidate.lastSubject || '',
            body: reply.body,
            timestamp: reply.timestamp,
            gmailMessageId: reply.gmailMessageId,
            gmailThreadId: reply.gmailThreadId,
            smtpMessageId: reply.messageId || '',
            read: false
          };

          if (!candidate.thread) candidate.thread = [];
          candidate.thread.push(msg);
          candidate.unread = true;
          candidate.lastGmailMessageId = reply.gmailMessageId;
          if (reply.messageId) {
            candidate.lastSmtpMessageId = reply.messageId;
            const newRef = `<${reply.messageId.replace(/^<|>$/g, '')}>`;
            candidate.gmailReferences = candidate.gmailReferences
              ? (candidate.gmailReferences.includes(newRef) ? candidate.gmailReferences : `${candidate.gmailReferences} ${newRef}`)
              : newRef;
          }

          // Handle resume attachment
          if (reply.resumeAttachment) {
            try {
              const fsAuto = require('fs');
              const pathAuto = require('path');
              const { DATA_DIR: DATA_DIR_AUTO } = require('./config');
              const resumeDir = pathAuto.join(DATA_DIR_AUTO, 'resumes');
              if (!fsAuto.existsSync(resumeDir)) fsAuto.mkdirSync(resumeDir, { recursive: true });
              const safeF = reply.resumeAttachment.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
              const storedF = `${candidate.id}_${Date.now()}_${safeF}`;
              const fPath = pathAuto.join(resumeDir, storedF);
              fsAuto.writeFileSync(fPath, reply.resumeAttachment.buffer);
              let txt = '';
              if (reply.resumeAttachment.mimeType.includes('pdf')) {
                const pp = require('pdf-parse');
                const parsed = await pp(reply.resumeAttachment.buffer);
                txt = parsed.text || '';
              } else if (reply.resumeAttachment.mimeType.includes('word') || reply.resumeAttachment.mimeType.includes('openxmlformats')) {
                const mm = require('mammoth');
                const r = await mm.extractRawText({ buffer: reply.resumeAttachment.buffer });
                txt = r.value || '';
              }
              candidate.resume = { filename: storedF, originalName: reply.resumeAttachment.filename, path: fPath, text: txt, mimetype: reply.resumeAttachment.mimeType, size: reply.resumeAttachment.buffer.length, uploadedAt: new Date().toISOString(), source: 'email' };
              if (!candidate.stepsCompleted) candidate.stepsCompleted = {};
              candidate.stepsCompleted.resumeReceived = true;
              const ri = stageOrder.indexOf('Resume Received');
              if (stageOrder.indexOf(candidate.stage || 'Imported') < ri) candidate.stage = 'Resume Received';
            } catch (aErr) { console.error('Auto-fetch resume error:', aErr.message); }
          }

          const ci = stageOrder.indexOf(candidate.stage || 'Imported');
          const ri = stageOrder.indexOf('Replied');
          if (ci < ri) candidate.stage = 'Replied';
          candidate.followUpDate = null;
          if (!candidate.gmailThreadId && reply.gmailThreadId) candidate.gmailThreadId = reply.gmailThreadId;

          // They replied — stop the automated follow-up sequence
          followupsSvc.cancelSequence(candidate.id);

          // Classify reply sentiment so the inbox can triage automatically
          try {
            const sent = await claudeSvc.classifyReply(candidate, reply.body, user);
            if (sent && sent.label) {
              candidate.replySentiment = sent.label;
              candidate.replySentimentReason = sent.reason || '';
              candidate.replySentimentAt = new Date().toISOString();
              if (sent.costCents) {
                user.credits    = Math.max(0, (user.credits    || 0) - sent.costCents);
                user.totalSpent = (user.totalSpent || 0) + sent.costCents;
                await storageService.saveUser(user);
              }
              // Auto-close the clearly-uninterested so they leave the active pipeline
              if (sent.label === 'not_interested') {
                candidate.stage = 'Closed';
                candidate.closedReason = 'Declined (auto-detected)';
              }
            }
          } catch (clsErr) { console.error('Reply classify error:', clsErr.message); }

          await storageService.saveCandidate(candidate);
          // Push notification for new reply
          pushSvc.sendNotification(user.id, {
            title: '💬 New Reply',
            body: `${candidate.name} replied to your email`,
            tag: `reply-${candidate.id}`,
            url: '/dashboard'
          }).catch(() => {});
          matched++;
        }

        if (matched > 0) console.log(`Auto-fetch: ${matched} new replies processed for ${user.email}`);
      } catch (uErr) {
        console.error(`Auto-fetch error for user ${user.id}:`, uErr.message);
      }
    }
  } catch (err) {
    console.error('Auto-fetch global error:', err.message);
  }
}

// Kick off 2 minutes after start (give server time to warm up), then every 10 min
setTimeout(() => {
  runAutoFetch();
  setInterval(runAutoFetch, AUTO_FETCH_MS);
}, 2 * 60 * 1000);

// ─── Weekly digest email (every Sunday night → Monday morning) ───────────────
const DIGEST_CHECK_MS = 60 * 60 * 1000; // check every hour

async function sendWeeklyDigest() {
  try {
    const storageService = require('./services/storage');
    const digestFile = require('path').join(DATA_DIR, '.last-digest');
    const fs2 = require('fs');

    // Only send once per week (7 days)
    if (fs2.existsSync(digestFile)) {
      const lastSent = new Date(fs2.readFileSync(digestFile, 'utf8').trim());
      if (Date.now() - lastSent.getTime() < 6.5 * 24 * 60 * 60 * 1000) return;
    }

    // Only send on Monday (day 1) between 8am–10am server time
    const now = new Date();
    if (now.getDay() !== 1 || now.getHours() < 8 || now.getHours() >= 10) return;

    // Claim this week's run up-front. If a send throws partway through the loop,
    // the next hourly tick won't restart the whole digest from the top.
    fs2.writeFileSync(digestFile, now.toISOString(), 'utf8');

    const users = await storageService.getAllUsers();
    for (const user of users) {
      const userEmail = _getUserEmailAddress(user);
      if (!_isEmailConnected(user) || !userEmail) continue;
      try {
        const candidates = await storageService.getUserCandidates(user.id);
        const stageOrder = ['Imported','Outreach Sent','Replied','Resume Requested','Resume Received','Interviewing','Closed'];
        const stageCounts = {};
        stageOrder.forEach(s => { stageCounts[s] = 0; });
        candidates.forEach(c => { if (stageCounts[c.stage] !== undefined) stageCounts[c.stage]++; });

        const overdue = candidates.filter(c => c.followUpDate && new Date(c.followUpDate) <= now && !['Closed'].includes(c.stage));
        const unread = candidates.filter(c => c.unread);

        const stageRows = stageOrder.map(s => `<tr><td style="padding:6px 12px;border-bottom:1px solid #f0f0f0">${s}</td><td style="padding:6px 12px;text-align:center;border-bottom:1px solid #f0f0f0;font-weight:600">${stageCounts[s]}</td></tr>`).join('');
        const overdueRows = overdue.length ? overdue.map(c => `<li style="margin:4px 0">${c.name} — ${c.stage} (due ${new Date(c.followUpDate).toLocaleDateString()})</li>`).join('') : '<li>None — great work!</li>';
        const unreadRows = unread.length ? unread.map(c => `<li style="margin:4px 0">${c.name} replied</li>`).join('') : '<li>None</li>';

        const body = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
<h2 style="color:#1a1a2e;margin-bottom:4px">Welltower Recruiter — Weekly Pipeline Report</h2>
<p style="color:#64748b;font-size:13px;margin-top:0">${now.toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}</p>
<h3 style="margin-top:24px">Pipeline Summary (${candidates.length} total)</h3>
<table style="border-collapse:collapse;width:100%;font-size:14px"><tbody>${stageRows}</tbody></table>
<h3 style="margin-top:24px">&#9200; Follow-ups Due (${overdue.length})</h3>
<ul style="font-size:14px;padding-left:20px">${overdueRows}</ul>
<h3>&#128236; Unread Replies (${unread.length})</h3>
<ul style="font-size:14px;padding-left:20px">${unreadRows}</ul>
<p style="margin-top:24px;font-size:12px;color:#94a3b8">Sent by Welltower Recruiter Platform</p></div>`;

        await _getEmailService(user).sendEmail(user.id, {
          to: userEmail,
          subject: `Welltower Recruiter — Weekly Digest (${now.toLocaleDateString()})`,
          body
        });

        console.log(`Weekly digest sent to ${userEmail}`);
      } catch (uErr) {
        console.error(`Digest error for ${user.id}:`, uErr.message);
      }
    }
  } catch (err) {
    console.error('Weekly digest error:', err.message);
  }
}

setInterval(sendWeeklyDigest, DIGEST_CHECK_MS);

module.exports = { app, DATA_DIR, BASE_URL };
