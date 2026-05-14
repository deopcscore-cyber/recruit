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
      'lastSubject', 'unread', 'opened', 'openedAt', 'thread', 'resume'
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

    const csvText = req.file.buffer.toString('utf8');
    let records;
    try {
      records = parse(csvText, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true
      });
    } catch (parseErr) {
      return res.status(400).json({ error: `CSV parse error: ${parseErr.message}` });
    }

    const importedCandidates = [];
    let skipped = 0;

    for (const row of records) {
      // Helper to get first matching key (case-insensitive)
      const get = (...keys) => {
        for (const key of keys) {
          const found = Object.keys(row).find(k => k.toLowerCase().trim() === key.toLowerCase());
          if (found && row[found] && row[found].trim()) return row[found].trim();
        }
        return '';
      };

      // Name resolution
      let name = get('Full Name', 'Name');
      if (!name) {
        const first = get('First Name', 'FirstName', 'First');
        const last = get('Last Name', 'LastName', 'Last');
        if (first || last) name = `${first} ${last}`.trim();
      }

      // Email resolution
      const email = get('Email', 'Email Address', 'Work Email', 'Primary Email');
      if (!email || !email.includes('@')) {
        skipped++;
        continue; // Skip rows with no valid email
      }

      const title = get('Title', 'Job Title', 'Current Title', 'Position');
      const company = get('Company', 'Current Company', 'Organization', 'Employer');
      const linkedin = get('LinkedIn URL', 'LinkedIn Profile', 'Profile URL', 'LinkedIn');
      const summary = get('Summary', 'Headline', 'Bio', 'Description');
      const background = get('Background', 'About', 'Overview');

      // Try to parse career/experience
      let career = [];
      const experienceRaw = get('Experience', 'Work Experience', 'Career History', 'Jobs');
      if (experienceRaw) {
        if (experienceRaw.startsWith('[') || experienceRaw.startsWith('{')) {
          try { career = JSON.parse(experienceRaw); } catch (e) {}
        } else {
          career = [{ description: experienceRaw }];
        }
      }

      // Try to parse education
      let education = [];
      const educationRaw = get('Education', 'Education History', 'Schools');
      if (educationRaw) {
        if (educationRaw.startsWith('[') || educationRaw.startsWith('{')) {
          try { education = JSON.parse(educationRaw); } catch (e) {}
        } else {
          education = [{ description: educationRaw }];
        }
      }

      const candidate = {
        ...makeDefaultCandidate(req.session.userId),
        name: name || email,
        email: email.toLowerCase(),
        title,
        company,
        linkedin,
        summary,
        background,
        career: Array.isArray(career) ? career : [],
        education: Array.isArray(education) ? education : []
      };

      await storage.saveCandidate(candidate);
      importedCandidates.push(candidate);
    }

    return res.json({
      imported: importedCandidates.length,
      skipped,
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
