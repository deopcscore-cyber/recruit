/* ============================================================
   Recruit Pro — Role Description PDF Builder
   Renders one or more structured role variants into a single,
   professionally formatted PDF (letterhead-style) for the
   candidate to review as an email attachment.
   ============================================================ */

const PDFDocument = require('pdfkit');

const NAVY   = '#1e293b';
const SLATE  = '#475569';
const MUTED  = '#94a3b8';
const ACCENT = '#2563eb';
const RULE   = '#e2e8f0';

function addHeader(doc, companyName, candidateName) {
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(18)
    .text(companyName || 'Confidential Role Overview', { align: 'left' });
  doc.moveDown(0.15);
  doc.fillColor(MUTED).font('Helvetica').fontSize(9.5)
    .text(`CONFIDENTIAL  ·  Prepared exclusively for ${candidateName || 'you'}`, { align: 'left', characterSpacing: 0.4 });
  doc.moveDown(0.6);
  doc.strokeColor(RULE).lineWidth(1)
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .stroke();
  doc.moveDown(1);
}

function addBullets(doc, items) {
  if (!items || !items.length) return;
  doc.font('Helvetica').fontSize(10.5).fillColor(SLATE);
  items.forEach(item => {
    const y = doc.y;
    doc.fillColor(ACCENT).text('•', doc.page.margins.left, y, { continued: false, width: 12 });
    doc.fillColor(SLATE).text(item, doc.page.margins.left + 14, y, {
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 14
    });
    doc.moveDown(0.35);
  });
}

function addSectionTitle(doc, text) {
  doc.moveDown(0.3);
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(12).text(text);
  doc.moveDown(0.25);
}

function addParagraph(doc, text) {
  if (!text) return;
  doc.font('Helvetica').fontSize(10.5).fillColor(SLATE).text(text, {
    width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
    lineGap: 2
  });
  doc.moveDown(0.5);
}

function addVariant(doc, companyName, jdLocation, variant, isFirst) {
  if (!isFirst) doc.addPage();

  doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(9.5)
    .text((variant.variantLabel || 'ROLE OPTION').toUpperCase(), { characterSpacing: 0.6 });
  doc.moveDown(0.15);
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(16).text(variant.title || 'Role Overview');
  doc.fillColor(MUTED).font('Helvetica').fontSize(10)
    .text(`${companyName || ''}${companyName && jdLocation ? '  |  ' : ''}${jdLocation || ''}`);
  doc.moveDown(0.7);
  doc.strokeColor(RULE).lineWidth(0.75)
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .stroke();
  doc.moveDown(0.7);

  if (variant.whyForYou) {
    addSectionTitle(doc, 'Why This Role Was Created With You In Mind');
    addParagraph(doc, variant.whyForYou);
  }
  if (variant.responsibilities && variant.responsibilities.length) {
    addSectionTitle(doc, 'What You Will Own');
    addBullets(doc, variant.responsibilities);
  }
  if (variant.qualifications && variant.qualifications.length) {
    addSectionTitle(doc, 'What You Bring');
    addBullets(doc, variant.qualifications);
  }
  if (variant.leadershipProfile) {
    addSectionTitle(doc, 'Leadership Profile');
    addParagraph(doc, variant.leadershipProfile);
  }

  const offerParts = [];
  if (variant.compensation) offerParts.push(['Compensation', variant.compensation]);
  if (variant.mission)      offerParts.push(['Mission', variant.mission]);
  if (variant.team)         offerParts.push(['Team', variant.team]);
  if (variant.growth)       offerParts.push(['Growth', variant.growth]);
  if (offerParts.length) {
    addSectionTitle(doc, `What ${companyName || 'We'} Offer${companyName ? 's' : ''}`);
    offerParts.forEach(([label, text]) => {
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(NAVY).text(label + ': ', { continued: true });
      doc.font('Helvetica').fillColor(SLATE).text(text);
      doc.moveDown(0.35);
    });
  }
}

/**
 * Build a role-description PDF containing one or more variants.
 * variants: [{ variantLabel, title, whyForYou, responsibilities[],
 *              qualifications[], leadershipProfile, compensation,
 *              mission, team, growth }]
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

      addHeader(doc, companyName, candidateName);
      (variants || []).forEach((variant, i) => addVariant(doc, companyName, jdLocation, variant, i === 0));

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { buildRoleJDPdf };
