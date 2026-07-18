const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const storage = require('../services/storage');
const requireAuth = require('../middleware/auth');
const { verifyEmailViaHunter } = require('../services/linkedin');

// All routes require auth
router.use(requireAuth);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const RESUMES_DIR = path.join(DATA_DIR, 'resumes');

// Multer setup for CSV uploads (memory)
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Multer setup for resume uploads (disk)
const resumeStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(RESUMES_DIR)) fs.mkdirSync(RESUMES_DIR, { recursive: true });
    cb(null, RESUMES_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${req.params.id}${ext}`);
  }
});
const resumeUpload = multer({
  storage: resumeStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.pdf' || ext === '.docx') return cb(null, true);
    cb(new Error('Only PDF and DOCX files are accepted'));
  }
});

function makeDefaultCandidate(userId) {
  return {
    id: uuidv4(),
    userId,
    name: '',
    email: '',
    title: '',
    company: '',
    linkedin: '',
    background: '',
    career: [],
    education: [],
    summary: '',
    emailStatus: '',      // '' (never checked) | 'deliverable' | 'risky' | 'undeliverable' | 'unknown'
    emailVerifiedAt: null,
    stage: 'Imported',
    thread: [],
    stepsCompleted: {
      outreach: false,
      roleJD: false,
      resumeRequested: false,
      resumeReceived: false,
      reviewSent: false,
      victorySent: false,
      interestChecked: false
    },
    resume: { text: '', filename: '', uploadedAt: null },
    notes: '',
    tags: [],
    unread: false,
    opened: false,
    openedAt: null,
    trackingId: uuidv4(),
    followUpDate: null,
    gmailThreadId: null,
    lastGmailMessageId: null,
    lastSubject: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

// GET /api/candidates
router.get('/', async (req, res) => {
  try {
    const candidates = await storage.getUserCandidates(req.session.userId);
    return res.json(candidates);
  } catch (err) {
    console.error('Get candidates error:', err);
    return res.status(500).json({ error: 'Failed to get candidates' });
  }
});

// POST /api/candidates/team-duplicate-check
// Body: { emails: [...] }  → which of these are already in ANOTHER teammate's
// pipeline. Prevents two recruiters from cold-contacting the same person.
// Returns minimal info (teammate name + stage), never their full record.
router.post('/team-duplicate-check', async (req, res) => {
  try {
    const { emails } = req.body;
    if (!Array.isArray(emails) || !emails.length) return res.json({ matches: {} });

    const wanted = new Set(emails.map(e => String(e || '').toLowerCase().trim()).filter(Boolean));
    const [allCandidates, allUsers] = await Promise.all([
      storage.getAllCandidates(), storage.getAllUsers()
    ]);
    const userNames = new Map(allUsers.map(u => [u.id, u.name || u.email || 'A teammate']));

    const matches = {};
    for (const c of allCandidates) {
      if (c.userId === req.session.userId) continue;       // only OTHER users
      const email = (c.email || '').toLowerCase().trim();
      if (email && wanted.has(email)) {
        matches[email] = { owner: userNames.get(c.userId) || 'A teammate', stage: c.stage || 'Imported' };
      }
    }
    return res.json({ matches });
  } catch (err) {
    console.error('Team duplicate check error:', err);
    return res.status(500).json({ error: 'Check failed' });
  }
});

// POST /api/candidates
router.post('/', async (req, res) => {
  try {
    const { name, email, title, company, linkedin, summary, notes, tags } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }

    // Duplicate check — same email already in this user's pipeline
    const existing = await storage.getUserCandidates(req.session.userId);
    const dupe = existing.find(c => c.email && c.email.toLowerCase() === email.toLowerCase().trim());
    if (dupe) {
      return res.status(409).json({
        error: `${dupe.name} is already in your pipeline with this email address.`,
        existingId: dupe.id
      });
    }

    const candidate = {
      ...makeDefaultCandidate(req.session.userId),
      name: name.trim(),
      email: email.toLowerCase().trim(),
      title: title || '',
      company: company || '',
      linkedin: linkedin || '',
      summary: summary || '',
      notes: notes || '',
      tags: Array.isArray(tags) ? tags : []
    };

    await storage.saveCandidate(candidate);
    return res.status(201).json(candidate);
  } catch (err) {
    console.error('Create candidate error:', err);
    return res.status(500).json({ error: 'Failed to create candidate' });
  }
});

// PUT /api/candidates/:id
router.put('/:id', async (req, res) => {
  try {
    const candidate = await storage.getCandidateById(req.params.id);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
    if (candidate.userId !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });

    // Snapshot before mutating — used below to detect newly-completed steps
    // so we can kick off that stage's follow-up sequence.
    const stepsBefore = { ...(candidate.stepsCompleted || {}) };

    // Merge updates — allow updating most fields
    const allowed = [
      'name', 'email', 'title', 'company', 'linkedin', 'background',
      'career', 'education', 'summary', 'stage', 'notes', 'tags',
      'stepsCompleted', 'followUpDate', 'gmailThreadId', 'lastGmailMessageId',
      'lastSmtpMessageId', 'lastSubject', 'unread', 'opened', 'openedAt', 'thread', 'resume',
      'originalSubject', 'gmailReferences', 'score', 'scoreDetails', 'pendingFollowUpDraft'
    ];

    // A previous deliverability check no longer means anything once the
    // address it was run against changes — clear it rather than leave a
    // stale "Verified" badge pointing at the wrong email.
    if (req.body.email !== undefined && req.body.email !== candidate.email) {
      candidate.emailStatus = '';
      candidate.emailVerifiedAt = null;
    }

    allowed.forEach(key => {
      if (req.body[key] !== undefined) {
        candidate[key] = req.body[key];
      }
    });

    // Merge stepsCompleted rather than replace
    if (req.body.stepsCompleted) {
      candidate.stepsCompleted = { ...candidate.stepsCompleted, ...req.body.stepsCompleted };
    }

    // A step just flipped from not-done to done → start that stage's
    // follow-up sequence (auto-send for roleJD/resumeRequested, draft-only
    // for review/victory — see services/followups.js KIND_DEFAULTS).
    const STEP_TO_FOLLOWUP_KIND = {
      roleJD: 'roleJD', resumeRequested: 'resumeRequested',
      reviewSent: 'review', victorySent: 'victory'
    };
    const newlyCompleted = Object.entries(STEP_TO_FOLLOWUP_KIND)
      .filter(([step]) => !stepsBefore[step] && candidate.stepsCompleted?.[step]);
    if (newlyCompleted.length) {
      try {
        const user = await storage.getUserById(req.session.userId);
        if (user) {
          const followupsSvc = require('../services/followups');
          for (const [, kind] of newlyCompleted) followupsSvc.scheduleSequence(user, candidate, kind);
        }
      } catch (fuErr) { console.error('Stage follow-up schedule error:', fuErr.message); }
    }

    // Notes history — append new note entry
    if (req.body.noteText && req.body.noteText.trim()) {
      if (!candidate.notesHistory) candidate.notesHistory = [];
      candidate.notesHistory.push({
        id: require('uuid').v4(),
        text: req.body.noteText.trim(),
        timestamp: new Date().toISOString(),
        author: req.session.userName || 'Recruiter'
      });
      candidate.notes = req.body.noteText.trim(); // keep notes in sync
    }

    await storage.saveCandidate(candidate);
    return res.json(candidate);
  } catch (err) {
    console.error('Update candidate error:', err);
    return res.status(500).json({ error: 'Failed to update candidate' });
  }
});

// DELETE /api/candidates/bulk  — delete multiple candidates by ID array
// Body: { ids: ["id1","id2",...] }
router.delete('/bulk', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'Provide an ids array' });

    const candidates = await storage.getAllCandidates();
    const idSet = new Set(ids);

    // Only allow deleting own candidates
    const toDelete = candidates.filter(c => idSet.has(c.id) && c.userId === req.session.userId);
    const updated  = candidates.filter(c => !idSet.has(c.id) || c.userId !== req.session.userId);
    await storage.saveAllCandidates(updated);

    // Clean up resume files
    toDelete.forEach(c => {
      ['pdf', 'docx'].forEach(ext => {
        const p = path.join(RESUMES_DIR, `${c.id}.${ext}`);
        if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (_) {}
      });
    });

    return res.json({ success: true, deleted: toDelete.length });
  } catch (err) {
    console.error('Bulk delete error:', err);
    return res.status(500).json({ error: 'Failed to bulk delete' });
  }
});

// DELETE /api/candidates/:id
router.delete('/:id', async (req, res) => {
  try {
    const candidates = await storage.getAllCandidates();
    const candidate = candidates.find(c => c.id === req.params.id);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
    if (candidate.userId !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });

    const updated = candidates.filter(c => c.id !== req.params.id);
    await storage.saveAllCandidates(updated);

    // Clean up resume file if exists
    ['pdf', 'docx'].forEach(ext => {
      const resumePath = path.join(RESUMES_DIR, `${req.params.id}.${ext}`);
      if (fs.existsSync(resumePath)) {
        try { fs.unlinkSync(resumePath); } catch (e) {}
      }
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Delete candidate error:', err);
    return res.status(500).json({ error: 'Failed to delete candidate' });
  }
});

// POST /api/candidates/:id/verify-email
// Manual re-check — covers candidates imported before a Hunter key was
// configured, or whose email was hand-edited since the last check.
router.post('/:id/verify-email', async (req, res) => {
  try {
    const candidate = await storage.getCandidateById(req.params.id);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
    if (candidate.userId !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });

    const user = await storage.getUserById(req.session.userId);
    if (!user?.hunterApiKey) {
      return res.status(400).json({ error: 'Add a Hunter.io API key in Settings to verify emails.' });
    }
    if (!candidate.email) {
      return res.status(400).json({ error: 'This candidate has no email to verify.' });
    }

    const result = await verifyEmailViaHunter(candidate.email, user.hunterApiKey);
    candidate.emailStatus = result || 'unknown';
    candidate.emailVerifiedAt = new Date().toISOString();
    candidate.updatedAt = new Date().toISOString();
    await storage.saveCandidate(candidate);

    return res.json(candidate);
  } catch (err) {
    console.error('Verify email error:', err);
    return res.status(500).json({ error: 'Verification failed: ' + err.message });
  }
});

// POST /api/candidates/import
router.post('/import', csvUpload.single('csv'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'CSV file required' });

    // Strip UTF-8 BOM if present (common in ContactOut exports and Windows CSV files)
    let csvText = req.file.buffer.toString('utf8');
    if (csvText.charCodeAt(0) === 0xFEFF) csvText = csvText.slice(1);

    let records;
    try {
      records = parse(csvText, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        relax_quotes: true,
        bom: true
      });
    } catch (parseErr) {
      console.error('CSV parse error:', parseErr.message);
      return res.status(400).json({ error: `CSV parse error: ${parseErr.message}` });
    }

    if (!records || records.length === 0) {
      return res.status(400).json({ error: 'CSV file appears to be empty or has no data rows' });
    }

    // Log detected headers for debugging
    const detectedHeaders = Object.keys(records[0] || {});
    console.log('CSV import — detected headers:', detectedHeaders);

    const existingCandidates = await storage.getUserCandidates(req.session.userId);
    const importedCandidates = [];
    let skipped = 0;
    let duplicates = 0;

    // Email verification (Hunter.io) — only runs if the recruiter has a key
    // configured in Settings; skipped entirely (not just per-row) otherwise
    // so an unconfigured account doesn't pay a network round-trip per row.
    const importingUser = await storage.getUserById(req.session.userId);
    const hunterApiKey = importingUser?.hunterApiKey || '';
    const verifyCounts = { deliverable: 0, risky: 0, undeliverable: 0, unknown: 0 };

    // Build a normalized header map once (strips BOM, lowercases, and reduces
    // to alphanumeric-only so "Job Title", "job_title", and "job-title" all
    // collapse to the same key — needed for snake_case exports like
    // LeadsFinder's alongside ContactOut's space-separated Title Case).
    const normHeaderKey = s => (s || '').replace(/^﻿/, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const headerMap = {};
    detectedHeaders.forEach(h => {
      headerMap[normHeaderKey(h)] = h;
    });

    // Exact-match getter only (post-normalization) — avoids false positives from contains
    const getFromRow = (row, ...keywords) => {
      for (const kw of keywords) {
        const origKey = headerMap[normHeaderKey(kw)];
        if (origKey && row[origKey] && String(row[origKey]).trim()) {
          return String(row[origKey]).trim();
        }
      }
      return '';
    };

    // Personal vs. work email are frequently separate columns (e.g. LeadsFinder's
    // "email" + "personal_email"), so pull them independently rather than
    // collapsing to one "best guess" column — that's what makes the
    // prefer-personal-email choice below meaningful instead of arbitrary.
    // Only explicitly-labeled columns count as "dedicated" here — a plain
    // "email" column is ambiguous (ContactOut's usual single-column export can
    // hold either kind) and must never be assumed to mean "work" just because
    // it's the only one present; it gets classified by domain below instead.
    const getPersonalEmailCol = (row) => getFromRow(row, 'personal email', 'personal_email', 'home email', 'home_email');
    const getWorkEmailCol     = (row) => getFromRow(row, 'work email', 'work_email', 'business email', 'business_email', 'company email');
    const getGenericEmailCol  = (row) => {
      const named = getFromRow(row,
        'email', 'email address', 'primary email', 'contact email',
        'work email 1', 'work email 2', 'email 1', 'email 2', 'email 3', 'email1', 'email2'
      );
      if (named) return named;
      // Last resort: scan all columns whose name contains 'email' for any
      // valid address — catches unusual header names none of the lists anticipated.
      for (const [normKey, origKey] of Object.entries(headerMap)) {
        if (normKey.includes('email')) {
          const val = row[origKey] ? String(row[origKey]).trim() : '';
          if (val.includes('@')) return val;
        }
      }
      return '';
    };
    const PERSONAL_DOMAIN_RE = /@(gmail|yahoo|hotmail|outlook|icloud|me|live|aol|protonmail|pm)\./i;
    // Default true — matches the "prioritize personal email" behavior already
    // used elsewhere in the app (extension import, LinkedIn import).
    const preferPersonalEmail = req.body.preferPersonalEmail !== 'false';

    // Resolves both addresses for a row from whichever columns are actually
    // present. Dedicated personal/work columns always win; a generic "email"
    // column only fills whichever slot is still empty, classified by domain
    // (gmail/yahoo/etc. → personal, everything else → work) rather than
    // defaulting to "work" just because it wasn't explicitly labeled.
    const resolveEmails = (row) => {
      let personalEmail = getPersonalEmailCol(row);
      let workEmail      = getWorkEmailCol(row);
      if (!personalEmail || !workEmail) {
        const generic = getGenericEmailCol(row);
        if (generic && generic !== personalEmail && generic !== workEmail) {
          if (PERSONAL_DOMAIN_RE.test(generic)) { if (!personalEmail) personalEmail = generic; }
          else                                   { if (!workEmail)     workEmail     = generic; }
        }
      }
      const email = preferPersonalEmail ? (personalEmail || workEmail) : (workEmail || personalEmail);
      return { email, personalEmail, workEmail };
    };

    for (const row of records) {
      // Name resolution — try combined first, then split first+last, then single-field
      let name = getFromRow(row, 'full name', 'name', 'contact name', 'candidate name', 'person name');
      if (!name) {
        const first = getFromRow(row, 'first name', 'firstname', 'given name', 'first');
        const last  = getFromRow(row, 'last name',  'lastname',  'family name', 'surname', 'last');
        if (first || last) name = `${first} ${last}`.trim();
      }

      // Email — skip row if no valid email found (personal or work)
      const { email, personalEmail, workEmail } = resolveEmails(row);
      if (!email || !email.includes('@')) {
        skipped++;
        continue;
      }

      // Skip duplicates (same email already in this user's pipeline)
      const isDuplicate = existingCandidates.some(ec => ec.email && email && ec.email.toLowerCase() === email.toLowerCase());
      if (isDuplicate) { duplicates++; continue; }

      // Core fields — ContactOut column names and common alternatives
      const title = getFromRow(row,
        'job title', 'title', 'current title', 'current job title',
        'position', 'role', 'current position', 'occupation'
      );
      const company = getFromRow(row,
        'company', 'company name', 'current company', 'current company name',
        'organization', 'employer', 'account name', 'employer name'
      );
      const linkedin = getFromRow(row,
        'linkedin url', 'linkedin profile url', 'linkedin profile',
        'linkedin link', 'profile url', 'linkedin'
      );
      const summary = getFromRow(row,
        'headline', 'summary', 'bio', 'description',
        'professional summary', 'overview', 'about'
      );
      const background = getFromRow(row, 'background', 'notes', 'additional info', 'additional notes');
      const location = getFromRow(row, 'location', 'city', 'region', 'country', 'geography');
      // Present in lead-gen exports (LeadsFinder etc.) that skip a free-text
      // background column in favor of structured firmographic fields.
      const industry  = getFromRow(row, 'industry');
      const seniority = getFromRow(row, 'seniority level', 'seniority');
      const companySize = getFromRow(row, 'company size', 'employee count');

      // Career / experience — ContactOut may export as JSON array or plain text
      let career = [];
      const experienceRaw = getFromRow(row,
        'experience', 'work experience', 'career history',
        'jobs', 'employment', 'work history', 'positions'
      );
      if (experienceRaw) {
        const trimmed = experienceRaw.trim();
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
          try {
            const parsed = JSON.parse(trimmed);
            career = Array.isArray(parsed) ? parsed : [parsed];
          } catch (e) {
            career = [{ description: trimmed }];
          }
        } else {
          career = [{ description: trimmed }];
        }
      }

      // Education
      let education = [];
      const educationRaw = getFromRow(row,
        'education', 'education history', 'schools',
        'university', 'degree', 'academic background'
      );
      if (educationRaw) {
        const trimmed = educationRaw.trim();
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
          try {
            const parsed = JSON.parse(trimmed);
            education = Array.isArray(parsed) ? parsed : [parsed];
          } catch (e) {
            education = [{ school: trimmed }];
          }
        } else {
          education = [{ school: trimmed }];
        }
      }

      // Build full summary including location if available
      const fullSummary = [summary, location ? `Location: ${location}` : ''].filter(Boolean).join(' | ');

      // No free-text background/notes column (LeadsFinder-style export) —
      // fall back to a compact line built from the firmographic fields that
      // are present, so the AI still has something to personalize against.
      const fallbackBackground = !background
        ? [
            title && company ? `${title} at ${company}` : (title || company),
            industry ? `Industry: ${industry}` : '',
            seniority ? `Seniority: ${seniority}` : '',
            companySize ? `Company size: ${companySize}` : ''
          ].filter(Boolean).join(' | ')
        : '';

      const candidate = {
        ...makeDefaultCandidate(req.session.userId),
        name: name || email.split('@')[0],
        email: email.toLowerCase().trim(),
        ...(personalEmail ? { personalEmail: personalEmail.toLowerCase().trim() } : {}),
        ...(workEmail     ? { workEmail:     workEmail.toLowerCase().trim() }     : {}),
        ...((personalEmail || workEmail) ? { emailSource: 'CSV import' } : {}),
        title,
        company,
        linkedin,
        summary: fullSummary || summary,
        background: background || fallbackBackground,
        career: Array.isArray(career) ? career : [],
        education: Array.isArray(education) ? education : []
      };

      if (hunterApiKey) {
        const result = await verifyEmailViaHunter(candidate.email, hunterApiKey);
        candidate.emailStatus = result || 'unknown';
        candidate.emailVerifiedAt = new Date().toISOString();
        verifyCounts[candidate.emailStatus] = (verifyCounts[candidate.emailStatus] || 0) + 1;
      }

      await storage.saveCandidate(candidate);
      importedCandidates.push(candidate);
    }

    console.log(`CSV import complete: ${importedCandidates.length} imported, ${skipped} skipped`);

    return res.json({
      imported: importedCandidates.length,
      skipped,
      verified: hunterApiKey ? verifyCounts : null,
      duplicates,
      candidates: importedCandidates
    });
  } catch (err) {
    console.error('Import error:', err);
    return res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

// POST /api/candidates/:id/resume
router.post('/:id/resume', resumeUpload.single('resume'), async (req, res) => {
  try {
    const candidate = await storage.getCandidateById(req.params.id);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
    if (candidate.userId !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
    if (!req.file) return res.status(400).json({ error: 'Resume file required' });

    const ext = path.extname(req.file.originalname).toLowerCase();
    let text = '';

    if (ext === '.pdf') {
      const pdfParse = require('pdf-parse');
      const fileBuffer = fs.readFileSync(req.file.path);
      const data = await pdfParse(fileBuffer);
      text = data.text;
    } else if (ext === '.docx') {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ path: req.file.path });
      text = result.value;
    }

    candidate.resume = {
      text: text.trim(),
      filename: req.file.originalname,
      uploadedAt: new Date().toISOString()
    };
    candidate.stepsCompleted.resumeReceived = true;
    candidate.stage = 'Resume Received';

    await storage.saveCandidate(candidate);
    return res.json({ success: true, candidate });
  } catch (err) {
    console.error('Resume upload error:', err);
    return res.status(500).json({ error: 'Resume upload failed: ' + err.message });
  }
});

// GET /api/candidates/:id/resume/download
router.get('/:id/resume/download', async (req, res) => {
  try {
    const candidate = await storage.getCandidateById(req.params.id);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
    if (candidate.userId !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });

    if (!candidate.resume || !candidate.resume.filename) {
      return res.status(404).json({ error: 'No resume on file' });
    }

    // Email-fetched resumes store an absolute `path`; uploaded ones live at {id}.ext
    let filePath = candidate.resume.path;
    if (!filePath || !fs.existsSync(filePath)) {
      const ext = path.extname(candidate.resume.filename).toLowerCase();
      filePath = path.join(RESUMES_DIR, `${req.params.id}${ext}`);
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Resume file not found on disk' });
    }

    // Sanitize the download filename to prevent header injection
    const safeName = (candidate.resume.originalName || candidate.resume.filename)
      .replace(/[\r\n"]/g, '').replace(/[^a-zA-Z0-9._ -]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.sendFile(path.resolve(filePath));
  } catch (err) {
    console.error('Resume download error:', err);
    return res.status(500).json({ error: 'Download failed' });
  }
});

// POST /api/candidates/:id/thread
router.post('/:id/thread', async (req, res) => {
  try {
    const candidate = await storage.getCandidateById(req.params.id);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
    if (candidate.userId !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });

    const { direction, subject, body, gmailMessageId, gmailThreadId } = req.body;
    if (!body) return res.status(400).json({ error: 'Message body required' });

    const message = {
      id: uuidv4(),
      direction: direction || 'inbound',
      subject: subject || candidate.lastSubject || '',
      body,
      timestamp: new Date().toISOString(),
      gmailMessageId: gmailMessageId || '',
      gmailThreadId: gmailThreadId || '',
      read: direction === 'outbound'
    };

    if (!candidate.thread) candidate.thread = [];
    candidate.thread.push(message);

    if (direction === 'inbound') {
      candidate.unread = true;
    }

    await storage.saveCandidate(candidate);
    return res.status(201).json({ message, candidate });
  } catch (err) {
    console.error('Add thread message error:', err);
    return res.status(500).json({ error: 'Failed to add message' });
  }
});

// POST /api/candidates/bulk-update
router.post('/bulk-update', requireAuth, async (req, res) => {
  try {
    const { ids, stage } = req.body;
    if (!ids || !Array.isArray(ids) || !stage) {
      return res.status(400).json({ error: 'ids (array) and stage are required' });
    }
    const validStages = ['Imported','Outreach Sent','Replied','Resume Requested','Resume Received','Interviewing','Closed'];
    if (!validStages.includes(stage)) {
      return res.status(400).json({ error: 'Invalid stage' });
    }
    const candidates = await storage.getAllCandidates();
    let updated = 0;
    for (const c of candidates) {
      if (ids.includes(c.id) && c.userId === req.session.userId) {
        c.stage = stage;
        c.updatedAt = new Date().toISOString();
        updated++;
      }
    }
    await storage.saveAllCandidates(candidates);
    return res.json({ updated });
  } catch (err) {
    console.error('Bulk update error:', err);
    return res.status(500).json({ error: 'Bulk update failed' });
  }
});

// POST /api/candidates/bulk-stage
router.post('/bulk-stage', async (req, res) => {
  try {
    const { ids, stage } = req.body;
    if (!Array.isArray(ids) || !stage) {
      return res.status(400).json({ error: 'ids array and stage are required' });
    }

    const allCandidates = await storage.getAllCandidates();
    let updated = 0;

    allCandidates.forEach(c => {
      if (ids.includes(c.id) && c.userId === req.session.userId) {
        c.stage = stage;
        c.updatedAt = new Date().toISOString();
        updated++;
      }
    });

    await storage.saveAllCandidates(allCandidates);
    return res.json({ updated });
  } catch (err) {
    console.error('Bulk stage error:', err);
    return res.status(500).json({ error: 'Bulk stage update failed' });
  }
});

// GET /api/candidates/accounts — other users on the platform (for transfer picker)
router.get('/accounts', requireAuth, async (req, res) => {
  try {
    const users = await storage.getAllUsers();
    const accounts = users
      .filter(u => u.id !== req.session.userId)
      .map(u => ({ id: u.id, name: u.name || '', email: u.email || '' }));
    return res.json({ accounts });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/candidates/transfer — move Imported candidates to another user's account
// Accepts toUserId (admin path) or toEmail (user-facing path)
router.post('/transfer', requireAuth, async (req, res) => {
  try {
    const { candidateIds, toUserId, toEmail } = req.body;
    if (!Array.isArray(candidateIds) || !candidateIds.length) return res.status(400).json({ error: 'candidateIds required' });

    let toUser;
    if (toEmail) {
      const users = await storage.getAllUsers();
      toUser = users.find(u => (u.email || '').toLowerCase() === toEmail.toLowerCase());
      if (!toUser) return res.status(404).json({ error: 'No account found with that email address' });
    } else if (toUserId) {
      toUser = await storage.getUserById(toUserId);
      if (!toUser) return res.status(404).json({ error: 'Target account not found' });
    } else {
      return res.status(400).json({ error: 'toEmail or toUserId required' });
    }
    if (toUser.id === req.session.userId) return res.status(400).json({ error: 'Cannot transfer to your own account' });

    const all = await storage.getAllCandidates();
    const ids = new Set(candidateIds);
    let moved = 0, skipped = 0;
    for (const c of all) {
      if (!ids.has(c.id) || c.userId !== req.session.userId) continue;
      if ((c.stepsCompleted || {}).outreach || (c.thread || []).some(m => m.direction === 'outbound')) {
        skipped++; continue; // only allow moving uncontacted candidates
      }
      c.userId = toUserId;
      c.updatedAt = new Date().toISOString();
      moved++;
    }
    await storage.saveAllCandidates(all);
    return res.json({ moved, skipped, toUser: toUser.name || toUser.email });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
