/* ============================================================
   Recruit Pro — Role Description PDF Builder
   Renders a role description in the style of a corporate
   careers-site posting (modeled on Welltower's careers pages):
   big title + meta line, all-caps company banner, SUMMARY,
   KEY RESPONSIBILITIES grouped under bold subheadings, TRAVEL,
   MINIMUM REQUIREMENTS, WHAT WE OFFER. No requisition numbers,
   no apply buttons — official and professional.
   ============================================================ */

const PDFDocument = require('pdfkit');

const NAVY   = '#1e293b';
const SLATE  = '#475569';
const MUTED  = '#94a3b8';
const ACCENT = '#2563eb';
const RULE   = '#e2e8f0';

function contentWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function addRule(doc) {
  doc.strokeColor(RULE).lineWidth(0.75)
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .stroke();
}

// Start a new page unless at least `needed` points of vertical space remain —
// keeps bullets/headers from being split or orphaned across page breaks.
function ensureSpace(doc, needed) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
}

function addBullets(doc, items) {
  if (!items || !items.length) return;
  items.forEach(item => {
    doc.font('Helvetica').fontSize(10.5);
    // The bullet glyph and its text are positioned independently, so a page
    // break between them orphans the dot — measure first and break as a unit.
    const h = doc.heightOfString(String(item), { width: contentWidth(doc) - 14 });
    ensureSpace(doc, h + 4);
    const y = doc.y;
    doc.fillColor(ACCENT).text('•', doc.page.margins.left, y, { continued: false, width: 12 });
    doc.fillColor(SLATE).text(String(item), doc.page.margins.left + 14, y, {
      width: contentWidth(doc) - 14
    });
    doc.moveDown(0.35);
  });
  // Reset x position after indented bullet rendering
  doc.text('', doc.page.margins.left, doc.y);
}

// ALL-CAPS section header, careers-posting style (SUMMARY, KEY RESPONSIBILITIES…)
function addCapsHeader(doc, text) {
  ensureSpace(doc, 70);
  doc.moveDown(0.7);
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(12)
    .text(String(text).toUpperCase(), { characterSpacing: 0.8 });
  doc.moveDown(0.35);
}

function addParagraphs(doc, text) {
  if (!text) return;
  String(text).split(/\n\s*\n/).forEach(par => {
    if (!par.trim()) return;
    doc.font('Helvetica').fontSize(10.5).fillColor(SLATE).text(par.trim(), {
      width: contentWidth(doc),
      lineGap: 2.2,
      align: 'left'
    });
    doc.moveDown(0.55);
  });
}

// ── Careers-posting layout (current variant shape) ───────────────────────────
function addCareersVariant(doc, companyName, jdLocation, variant, isFirst) {
  if (!isFirst) doc.addPage();

  // Kicker: company name, small caps, muted
  if (companyName) {
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9.5)
      .text(companyName.toUpperCase(), { characterSpacing: 1.2 });
    doc.moveDown(0.25);
  }

  // Big posting title
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(21)
    .text(variant.title || 'Role Overview', { lineGap: 1 });
  doc.moveDown(0.35);

  // Meta line: Full-Time · On-site · Location · Posted <date>
  const posted = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const meta = [variant.employmentType || 'Full-Time', variant.workMode, jdLocation, `Posted ${posted}`]
    .filter(Boolean).join('   ·   ');
  doc.fillColor(MUTED).font('Helvetica').fontSize(10).text(meta);
  doc.moveDown(0.8);
  addRule(doc);
  doc.moveDown(0.4);

  // Company banner: all-caps headline + culture/mission paragraphs
  if (variant.companyIntro && (variant.companyIntro.headline || variant.companyIntro.body)) {
    if (variant.companyIntro.headline) {
      doc.moveDown(0.4);
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(12)
        .text(String(variant.companyIntro.headline).toUpperCase(), { characterSpacing: 0.8 });
      doc.moveDown(0.35);
    }
    addParagraphs(doc, variant.companyIntro.body);
  }

  if (variant.summary) {
    addCapsHeader(doc, 'Summary');
    addParagraphs(doc, variant.summary);
  }

  if (variant.responsibilityGroups && variant.responsibilityGroups.length) {
    addCapsHeader(doc, 'Key Responsibilities');
    variant.responsibilityGroups.forEach(group => {
      if (group.heading) {
        ensureSpace(doc, 55);
        doc.moveDown(0.25);
        doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11).text(group.heading);
        doc.moveDown(0.25);
      }
      addBullets(doc, group.bullets);
    });
  }

  if (variant.travel && String(variant.travel).trim()) {
    addCapsHeader(doc, 'Travel');
    addParagraphs(doc, variant.travel);
  }

  if (variant.requirements && variant.requirements.length) {
    addCapsHeader(doc, 'Minimum Requirements');
    addBullets(doc, variant.requirements);
  }

  if (variant.whatWeOffer && variant.whatWeOffer.length) {
    addCapsHeader(doc, 'What We Offer');
    addBullets(doc, variant.whatWeOffer);
  }
}

// ── Legacy layout (variants queued before the careers-post redesign) ─────────
function addLegacyVariant(doc, companyName, jdLocation, variant, isFirst) {
  if (!isFirst) doc.addPage();

  doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(9.5)
    .text((variant.variantLabel || 'ROLE OPTION').toUpperCase(), { characterSpacing: 0.6 });
  doc.moveDown(0.15);
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(16).text(variant.title || 'Role Overview');
  doc.fillColor(MUTED).font('Helvetica').fontSize(10)
    .text(`${companyName || ''}${companyName && jdLocation ? '  |  ' : ''}${jdLocation || ''}`);
  doc.moveDown(0.7);
  addRule(doc);
  doc.moveDown(0.7);

  if (variant.whyForYou) {
    addCapsHeader(doc, 'Why This Role Was Created With You In Mind');
    addParagraphs(doc, variant.whyForYou);
  }
  if (variant.responsibilities && variant.responsibilities.length) {
    addCapsHeader(doc, 'What You Will Own');
    addBullets(doc, variant.responsibilities);
  }
  if (variant.qualifications && variant.qualifications.length) {
    addCapsHeader(doc, 'What You Bring');
    addBullets(doc, variant.qualifications);
  }
  if (variant.leadershipProfile) {
    addCapsHeader(doc, 'Leadership Profile');
    addParagraphs(doc, variant.leadershipProfile);
  }

  const offerParts = [];
  if (variant.compensation) offerParts.push(['Compensation', variant.compensation]);
  if (variant.mission)      offerParts.push(['Mission', variant.mission]);
  if (variant.team)         offerParts.push(['Team', variant.team]);
  if (variant.growth)       offerParts.push(['Growth', variant.growth]);
  if (offerParts.length) {
    addCapsHeader(doc, `What ${companyName || 'We'} Offer${companyName ? 's' : ''}`);
    offerParts.forEach(([label, text]) => {
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(NAVY).text(label + ': ', { continued: true });
      doc.font('Helvetica').fillColor(SLATE).text(text);
      doc.moveDown(0.35);
    });
  }
}

/**
 * Build a role-description PDF containing one or more variants.
 * Careers-post shape: { title, employmentType, workMode, companyIntro{headline,body},
 *   summary, responsibilityGroups[{heading,bullets[]}], travel, requirements[], whatWeOffer[] }
 * Legacy shape (pre-redesign queued jobs): { variantLabel, title, whyForYou,
 *   responsibilities[], qualifications[], leadershipProfile, compensation, mission, team, growth }
 * Returns a Promise<Buffer>.
 */
function buildRoleJDPdf({ companyName, candidateName, jdLocation, variants }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margins: { top: 56, bottom: 56, left: 56, right: 56 } });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      (variants || []).forEach((variant, i) => {
        if (variant && Array.isArray(variant.responsibilityGroups)) {
          addCareersVariant(doc, companyName, jdLocation, variant, i === 0);
        } else {
          addLegacyVariant(doc, companyName, jdLocation, variant, i === 0);
        }
      });

      // Discreet confidentiality footer instead of a top banner — keeps the
      // document looking like an official posting.
      doc.moveDown(1.2);
      addRule(doc);
      doc.moveDown(0.4);
      doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
        .text(`Confidential — this role overview was prepared for ${candidateName || 'the recipient'} and is not a public posting.`, {
          width: contentWidth(doc)
        });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { buildRoleJDPdf };
