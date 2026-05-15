const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const storage = require('../services/storage');
const requireAuth = require('../middleware/auth');

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

// POST /api/candidates
router.post('/', async (req, res) => {
  try {
    const { name, email, title, company, linkedin, summary, notes, tags } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
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

    // Merge updates — allow updating most fields
    const allowed = [
      'name', 'email', 'title', 'company', 'linkedin', 'background',
      'career', 'education', 'summary', 'stage', 'notes', 'tags',
      'stepsCompleted', 'followUpDate', 'gmailThreadId', 'lastGmailMessageId',
      'lastSmtpMessageId', 'lastSubject', 'unread', 'opened', 'openedAt', 'thread', 'resume',
      'originalSubject', 'gmailReferences', 'score', 'scoreDetails'
    ];

    allowed.forEach(key => {
      if (req.body[key] !== undefined) {
        candidate[key] = req.body[key];
      }
    });

    // Merge stepsCompleted rather than replace
    if (req.body.stepsCompleted) {
      candidate.stepsCompleted = { ...candidate.stepsCompleted, ...req.body.stepsCompleted };
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

    // Build a normalized header map once (strips BOM, lowercases, trims)
    const headerMap = {};
    detectedHeaders.forEach(h => {
      const normalized = h.replace(/^﻿/, '').toLowerCase().trim();
      headerMap[normalized] = h;
    });

    // Exact-match getter only — avoids false positives from contains
    const getFromRow = (row, ...keywords) => {
      for (const kw of keywords) {
        const kwLower = kw.toLowerCase().trim();
        const origKey = headerMap[kwLower];
        if (origKey && row[origKey] && String(row[origKey]).trim()) {
          return String(row[origKey]).trim();
        }
      }
      return '';
    };

    // Find the best email — tries a wide range of column names in priority order
    const getEmail = (row) => {
      // Ordered priority: exact names first
      const candidate = getFromRow(row,
        'email', 'email address', 'primary email',
        'work email', 'work email 1', 'work email 2',
        'email 1', 'email 2', 'email 3',
        'email1', 'email2',
        'personal email', 'contact email', 'business email'
      );
      if (candidate && candidate.includes('@')) return candidate;

      // Fallback: scan all columns whose name contains 'email' for any valid address
      for (const [normKey, origKey] of Object.entries(headerMap)) {
        if (normKey.includes('email')) {
          const val = row[origKey] ? String(row[origKey]).trim() : '';
          if (val.includes('@')) return val;
        }
      }
      return '';
    };

    for (const row of records) {
      // Name resolution — try combined first, then split first+last, then single-field
      let name = getFromRow(row, 'full name', 'name', 'contact name', 'candidate name', 'person name');
      if (!name) {
        const first = getFromRow(row, 'first name', 'firstname', 'given name', 'first');
        const last  = getFromRow(row, 'last name',  'lastname',  'family name', 'surname', 'last');
        if (first || last) name = `${first} ${last}`.trim();
      }

      // Email — skip row if no valid email found
      const email = getEmail(row);
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

      const candidate = {
        ...makeDefaultCandidate(req.session.userId),
        name: name || email.split('@')[0],
        email: email.toLowerCase().trim(),
        title,
        company,
        linkedin,
        summary: fullSummary || summary,
        background,
        career: Array.isArray(career) ? career : [],
        education: Array.isArray(education) ? education : []
      };

      await storage.saveCandidate(candidate);
      importedCandidates.push(candidate);
    }

    console.log(`CSV import complete: ${importedCandidates.length} imported, ${skipped} skipped`);

    return res.json({
      imported: importedCandidates.length,
      skipped,
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

    const ext = path.extname(candidate.resume.filename).toLowerCase();
    const filePath = path.join(RESUMES_DIR, `${req.params.id}${ext}`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Resume file not found on disk' });
    }

    res.setHeader('Content-Disposition', `attachment; filename="${candidate.resume.filename}"`);
    res.sendFile(filePath);
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

module.exports = router;
