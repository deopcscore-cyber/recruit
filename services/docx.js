/* ============================================================
   Recruit Pro — Role Description DOCX Builder
   Same careers-site-posting content as services/pdf.js, rendered
   as a native, fully editable Word document so a recruiter can
   review and adjust the wording before it goes to a candidate.
   ============================================================ */

const {
  Document, Packer, Paragraph, TextRun, PageBreak,
  AlignmentType, BorderStyle, LevelFormat, convertInchesToTwip
} = require('docx');

const NAVY   = '1e293b';
const SLATE  = '334155';
const MUTED  = '64748b';
const RULE   = 'cbd5e1';

const BULLET_REF = 'role-jd-bullets';

const numberingConfig = {
  config: [{
    reference: BULLET_REF,
    levels: [{
      level: 0,
      format: LevelFormat.BULLET,
      text: '•',
      alignment: AlignmentType.LEFT,
      style: {
        paragraph: {
          indent: { left: convertInchesToTwip(0.28), hanging: convertInchesToTwip(0.22) }
        }
      }
    }]
  }]
};

function rule() {
  return new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 2 } },
    spacing: { after: 200 }
  });
}

function capsHeader(text) {
  return new Paragraph({
    spacing: { before: 320, after: 120 },
    children: [new TextRun({ text: String(text).toUpperCase(), bold: true, color: NAVY, size: 24 })]
  });
}

function groupHeading(text) {
  return new Paragraph({
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text: String(text), bold: true, color: NAVY, size: 22 })]
  });
}

function bodyParagraphs(text, { size = 21, color = SLATE, spacingAfter = 220 } = {}) {
  if (!text) return [];
  return String(text).split(/\n\s*\n/).filter(p => p.trim()).map(par =>
    new Paragraph({
      spacing: { after: spacingAfter, line: 300 },
      children: [new TextRun({ text: par.trim(), color, size })]
    })
  );
}

function bulletList(items, { size = 21, color = SLATE } = {}) {
  if (!items || !items.length) return [];
  return items.map(item => new Paragraph({
    numbering: { reference: BULLET_REF, level: 0 },
    spacing: { after: 120, line: 280 },
    children: [new TextRun({ text: String(item), color, size })]
  }));
}

function buildVariantSection(companyName, jdLocation, variant, isFirst) {
  const children = [];
  if (!isFirst) {
    children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  if (companyName) {
    children.push(new Paragraph({
      spacing: { after: 60 },
      children: [new TextRun({ text: companyName.toUpperCase(), bold: true, color: MUTED, size: 18 })]
    }));
  }

  children.push(new Paragraph({
    spacing: { after: 100 },
    children: [new TextRun({ text: variant.title || 'Role Overview', bold: true, color: NAVY, size: 42 })]
  }));

  const meta = [variant.employmentType || 'Full-Time', variant.workMode, jdLocation].filter(Boolean).join('   ·   ');
  if (meta) {
    children.push(new Paragraph({
      spacing: { after: 200 },
      children: [new TextRun({ text: meta, color: MUTED, size: 20 })]
    }));
  }
  children.push(rule());

  if (variant.companyIntro && (variant.companyIntro.headline || variant.companyIntro.body)) {
    if (variant.companyIntro.headline) {
      children.push(new Paragraph({
        spacing: { before: 120, after: 120 },
        children: [new TextRun({ text: String(variant.companyIntro.headline).toUpperCase(), bold: true, color: NAVY, size: 24 })]
      }));
    }
    children.push(...bodyParagraphs(variant.companyIntro.body));
  }

  if (variant.summary) {
    children.push(capsHeader('Summary'));
    children.push(...bodyParagraphs(variant.summary));
  }

  if (variant.responsibilityGroups && variant.responsibilityGroups.length) {
    children.push(capsHeader('Key Responsibilities'));
    variant.responsibilityGroups.forEach(group => {
      if (group.heading) children.push(groupHeading(group.heading));
      children.push(...bulletList(group.bullets));
    });
  }

  if (variant.requirements && variant.requirements.length) {
    children.push(capsHeader('Minimum Requirements'));
    children.push(...bulletList(variant.requirements));
  }

  if (variant.whatWeOffer && variant.whatWeOffer.length) {
    children.push(capsHeader('What We Offer'));
    children.push(...bulletList(variant.whatWeOffer));
  }

  // Legacy shape (variants queued before the careers-post redesign) — no
  // responsibilityGroups, so render the older field set instead.
  if (!variant.responsibilityGroups) {
    if (variant.whyForYou) {
      children.push(capsHeader('Why This Role Was Created With You In Mind'));
      children.push(...bodyParagraphs(variant.whyForYou));
    }
    if (variant.responsibilities && variant.responsibilities.length) {
      children.push(capsHeader('What You Will Own'));
      children.push(...bulletList(variant.responsibilities));
    }
    if (variant.qualifications && variant.qualifications.length) {
      children.push(capsHeader('What You Bring'));
      children.push(...bulletList(variant.qualifications));
    }
    if (variant.leadershipProfile) {
      children.push(capsHeader('Leadership Profile'));
      children.push(...bodyParagraphs(variant.leadershipProfile));
    }
    const offerParts = [];
    if (variant.compensation) offerParts.push(['Compensation', variant.compensation]);
    if (variant.mission)      offerParts.push(['Mission', variant.mission]);
    if (variant.team)         offerParts.push(['Team', variant.team]);
    if (variant.growth)       offerParts.push(['Growth', variant.growth]);
    if (offerParts.length) {
      children.push(capsHeader(`What ${companyName || 'We'} Offer${companyName ? 's' : ''}`));
      offerParts.forEach(([label, text]) => {
        children.push(new Paragraph({
          spacing: { after: 120 },
          children: [
            new TextRun({ text: label + ': ', bold: true, color: NAVY, size: 21 }),
            new TextRun({ text, color: SLATE, size: 21 })
          ]
        }));
      });
    }
  }

  return children;
}

/**
 * Build a role-description DOCX containing one or more variants, fully
 * editable by the recruiter before it's attached to an outbound email.
 * Returns a Promise<Buffer>.
 */
async function buildRoleJDDocx({ companyName, candidateName, jdLocation, variants }) {
  const allChildren = [];
  (variants || []).forEach((variant, i) => {
    allChildren.push(...buildVariantSection(companyName, jdLocation, variant, i === 0));
  });

  allChildren.push(rule());
  allChildren.push(new Paragraph({
    children: [new TextRun({
      text: `Confidential — this role overview was prepared for ${candidateName || 'the recipient'}.`,
      italics: true, color: MUTED, size: 17
    })]
  }));

  const doc = new Document({
    creator: companyName || 'Recruit Pro',
    title: (variants && variants[0] && variants[0].title) || 'Role Overview',
    numbering: numberingConfig,
    sections: [{
      properties: {
        page: { margin: { top: 1008, bottom: 1008, left: 1008, right: 1008 } }
      },
      children: allChildren
    }]
  });

  return Packer.toBuffer(doc);
}

module.exports = { buildRoleJDDocx };
