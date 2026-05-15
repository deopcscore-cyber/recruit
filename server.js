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
app.use('/api/analytics',  require('./routes/analytics'));

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

// ─── Auto-fetch emails every 10 minutes ──────────────────────────────────────
const AUTO_FETCH_MS = 10 * 60 * 1000;

async function runAutoFetch() {
  try {
    const storageService = require('./services/storage');
    const gmailSvc = require('./services/gmail');

    const users = await storageService.getAllUsers();
    for (const user of users) {
      if (!user.gmail || !user.gmail.connected) continue;
      try {
        const replies = await gmailSvc.fetchUnreadReplies(user.id);
        if (!replies.length) continue;

        const candidates = await storageService.getUserCandidates(user.id);
        const stageOrder = ['Imported','Outreach Sent','Replied','Resume Requested','Resume Received','Interviewing','Closed'];
        let matched = 0;

        for (const reply of replies) {
          const fromEmail = reply.from ? (reply.from.match(/<([^>]+)>/) || [,''])[1].trim() || reply.from.trim() : '';
          if (!fromEmail) continue;
          const candidate = candidates.find(c => c.email && c.email.toLowerCase() === fromEmail.toLowerCase());
          if (!candidate) continue;
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

          await storageService.saveCandidate(candidate);
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
    const gmailSvc = require('./services/gmail');
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

    const users = await storageService.getAllUsers();
    for (const user of users) {
      if (!user.gmail || !user.gmail.connected || !user.gmail.address) continue;
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

        await gmailSvc.sendEmail(user.id, {
          to: user.gmail.address,
          subject: `Welltower Recruiter — Weekly Digest (${now.toLocaleDateString()})`,
          body
        });

        fs2.writeFileSync(digestFile, now.toISOString(), 'utf8');
        console.log(`Weekly digest sent to ${user.gmail.address}`);
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
