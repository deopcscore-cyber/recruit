const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Strip markdown symbols so JD emails arrive as clean readable text
function stripMarkdown(text) {
  return text
    // ATX headers  → UPPERCASE plain line
    .replace(/^#{1,6}\s+(.+)$/gm, (_, t) => t.toUpperCase())
    // Bold / italic markers
    .replace(/\*{1,3}([^*\n]+)\*{1,3}/g, '$1')
    .replace(/_{1,2}([^_\n]+)_{1,2}/g, '$1')
    // Horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // Trailing spaces on lines
    .replace(/ +$/gm, '')
    // Collapse 3+ blank lines into 2
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const MODEL = 'claude-sonnet-4-6';

function formatCandidateContext(candidate) {
  const lines = [];
  lines.push(`Name: ${candidate.name || 'Unknown'}`);
  if (candidate.title) lines.push(`Current Title: ${candidate.title}`);
  if (candidate.company) lines.push(`Current Company: ${candidate.company}`);
  if (candidate.email) lines.push(`Email: ${candidate.email}`);
  if (candidate.linkedin) lines.push(`LinkedIn: ${candidate.linkedin}`);
  if (candidate.summary) lines.push(`Summary/Headline: ${candidate.summary}`);
  if (candidate.background) lines.push(`Background: ${candidate.background}`);

  if (candidate.career && candidate.career.length > 0) {
    lines.push('\nCareer History:');
    candidate.career.forEach(job => {
      const parts = [];
      if (job.title) parts.push(job.title);
      if (job.company) parts.push(`at ${job.company}`);
      if (job.dates || job.duration) parts.push(`(${job.dates || job.duration})`);
      lines.push(`  - ${parts.join(' ')}`);
      if (job.description) lines.push(`    ${job.description}`);
    });
  }

  if (candidate.education && candidate.education.length > 0) {
    lines.push('\nEducation:');
    candidate.education.forEach(edu => {
      const parts = [];
      if (edu.degree) parts.push(edu.degree);
      if (edu.school || edu.institution) parts.push(`from ${edu.school || edu.institution}`);
      if (edu.year || edu.dates) parts.push(`(${edu.year || edu.dates})`);
      lines.push(`  - ${parts.join(' ')}`);
    });
  }

  if (candidate.resume && candidate.resume.text) {
    lines.push('\nResume Text (first 3000 chars):');
    lines.push(candidate.resume.text.substring(0, 3000));
  }

  return lines.join('\n');
}

function formatUserStyle(user) {
  const style = user.style || {};
  const lines = [];
  if (style.tone) lines.push(`Tone: ${style.tone}`);
  if (style.notes) lines.push(`Additional notes: ${style.notes}`);
  if (style.use && style.use.length > 0) lines.push(`Phrases to use: ${style.use.join(', ')}`);
  if (style.avoid && style.avoid.length > 0) lines.push(`Phrases to avoid: ${style.avoid.join(', ')}`);
  return lines.join('\n') || 'Warm, professional, human';
}

async function generateOutreach(candidate, user) {
  const candidateInfo = formatCandidateContext(candidate);
  const styleInfo = formatUserStyle(user);

  const prompt = `You are writing a personalized outreach email from a recruiter at Welltower Inc. to an executive candidate.

RECRUITER STYLE:
${styleInfo}

CANDIDATE INFORMATION:
${candidateInfo}

INSTRUCTIONS:
- Open by noticing the arc and span of their career — reference specific companies and transitions they've made, showing you actually read their background
- Explain Welltower's unique position at the healthcare + real estate intersection, global scale (one of the largest healthcare REITs in the world), and mission-driven culture focused on improving senior housing and healthcare infrastructure
- End with exactly: "May I send over the details?" — NEVER mention a specific job title
- Keep it under 250 words
- Sign as: ${user.name}\nRecruiter — Welltower Inc.
- Sound like a real human recruiter — warm, genuine, not a bot or template
- Output ONLY the message body, no subject line, no extra commentary

Write the outreach email now:`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text.trim();
}

async function generateRoleJD(candidate, user) {
  const candidateInfo = formatCandidateContext(candidate);
  const styleInfo = formatUserStyle(user);

  const prompt = `You are creating a tailored leadership role description for Welltower Inc. to present to a specific executive candidate.

RECRUITER STYLE:
${styleInfo}

CANDIDATE INFORMATION:
${candidateInfo}

INSTRUCTIONS:
Create a detailed, personalized role description that feels written specifically for this person. Include these six sections, each separated by a blank line. DO NOT use any markdown formatting — no #, **, *, or --- symbols. Use plain text only. Use ALL CAPS for section headings.

1. ROLE TITLE — create one that fits their background and Welltower's needs. Put it on its own line after the heading.

2. WHY THIS ROLE WAS CREATED WITH YOU IN MIND — reference their actual companies, roles, and transitions (2-3 sentences that feel deeply personal, not generic).

3. WHAT YOU WILL OWN — 8-10 specific bullet points (use a dash "-" prefix) covering strategic responsibilities tailored to their background.

4. WHAT YOU BRING — 8-10 bullet points (use a dash "-" prefix) that mirror their actual experience and strengths, referencing real companies and roles they have held.

5. LEADERSHIP PROFILE — the kind of leader Welltower is looking for (3-4 sentences, specific to this candidate's style).

6. WHAT WELLTOWER OFFERS
   - Compensation: Base salary $400,000 – $500,000 depending on experience, plus annual performance bonus (target 30–40% of base), long-term equity participation through Welltower stock grants, and a comprehensive executive benefits package including healthcare, 401(k) match, and executive life insurance.
   - Mission: (2-3 sentences on Welltower's position in healthcare real estate)
   - Team: (1-2 sentences on culture)
   - Growth: (1-2 sentences on career trajectory)

Make it compelling and specific — not generic. Reference their real background throughout.

Write the role description now:`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }]
  });

  return stripMarkdown(response.content[0].text.trim());
}

async function generateResumeFeedback(candidate, user) {
  const candidateInfo = formatCandidateContext(candidate);
  const styleInfo = formatUserStyle(user);

  if (!candidate.resume || !candidate.resume.text) {
    throw new Error('No resume text available for this candidate');
  }

  const prompt = `You are a recruiter at Welltower Inc. reviewing an executive candidate's resume.

RECRUITER STYLE:
${styleInfo}

CANDIDATE INFORMATION:
${candidateInfo}

TASK: Identify 3-4 specific, concrete gaps in this resume — reference actual content (what's missing or weak), not generic advice. Then draft a warm email offering professional resume support.

OUTPUT FORMAT (return valid JSON):
{
  "gaps": "A clear paragraph listing the 3-4 specific gaps you identified, referencing actual content from the resume",
  "email": "The email body asking if they are open to professional support — warm, specific, NOT generic. Do NOT mention 'Victory' or any specific service yet. Just ask if they'd be open to connecting with someone who specializes in executive positioning. Under 180 words. Sign as ${user.name}, Recruiter — Welltower Inc."
}

Return only the JSON object, no markdown, no extra text.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content[0].text.trim();
  try {
    // Strip markdown code blocks if present
    const clean = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    // Try to extract JSON if embedded in text
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    // Fallback: return as structured object
    return { gaps: text, email: '' };
  }
}

async function generateVictoryEmail(candidate, user) {
  const candidateInfo = formatCandidateContext(candidate);
  const styleInfo = formatUserStyle(user);

  const prompt = `You are a recruiter at Welltower Inc. drafting an email to introduce an executive candidate to Victory at Toby Career Consults.

RECRUITER STYLE:
${styleInfo}

CANDIDATE INFORMATION:
${candidateInfo}

INSTRUCTIONS:
- Draft a warm, personal email introducing Victory at Toby Career Consults (victory@tobycareerconsults.com)
- Victory specializes in executive resume writing and career positioning
- Feel personal, not salesy — like a genuine recommendation from someone who wants to help
- Reference the candidate by name
- Keep it under 200 words
- Sign as: ${user.name}\nRecruiter — Welltower Inc.
- Output ONLY the email body, no subject line

Write the Victory introduction email now:`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text.trim();
}

async function generateReply(candidate, user, lastMessage) {
  const candidateInfo = formatCandidateContext(candidate);
  const styleInfo = formatUserStyle(user);

  // Build thread context, stripping timestamp fields to keep it clean
  const threadContext = (candidate.thread || []).map(msg => {
    return {
      direction: msg.direction,
      subject: msg.subject,
      body: msg.body
    };
  });

  const lastMsg = lastMessage || (threadContext.length > 0 ? threadContext[threadContext.length - 1].body : '');

  const stepsCompleted = candidate.stepsCompleted || {};

  const prompt = `You are a recruiter at Welltower Inc. drafting a reply to an executive candidate. This is a REAL ongoing conversation — your reply must feel like a genuine human response, not a template.

RECRUITER STYLE:
${styleInfo}

CANDIDATE INFORMATION:
${candidateInfo}

CONVERSATION HISTORY (most recent last):
${JSON.stringify(threadContext, null, 2)}

MOST RECENT MESSAGE FROM CANDIDATE:
${lastMsg}

CURRENT PIPELINE STATUS:
- Outreach sent: ${stepsCompleted.outreach ? 'Yes' : 'No'}
- Role JD sent: ${stepsCompleted.roleJD ? 'Yes' : 'No'}
- Resume requested: ${stepsCompleted.resumeRequested ? 'Yes' : 'No'}
- Resume received: ${stepsCompleted.resumeReceived ? 'Yes' : 'No'}
- Resume review sent: ${stepsCompleted.reviewSent ? 'Yes' : 'No'}
- Victory intro sent: ${stepsCompleted.victorySent ? 'Yes' : 'No'}

INSTRUCTIONS — follow every rule:
1. OPEN by directly acknowledging something SPECIFIC from their last message — quote or closely paraphrase their exact words so they know you actually read what they wrote. NEVER skip this. NEVER open with a generic line like "Thank you for getting back to me."
2. If they mentioned availability, a specific interest, a concern, or a question — address it directly in plain conversational language.
3. If they asked for a call or mentioned scheduling: acknowledge warmly, say you are looking forward to connecting, but explain you would love to review their resume first to make the most of their time.
4. If resume has not been requested yet: after acknowledging their message naturally, ask them to share their resume.
5. If resume was already requested and not yet received: keep the tone light, reference something they said, and follow up gently.
6. Sound like a person having a real back-and-forth conversation — warm, unhurried, specific. NOT scripted. NOT formulaic.
7. Under 180 words.
8. Sign as: ${user.name}\\nRecruiter — Welltower Inc.
9. Output ONLY the reply body. No subject line.

Write the reply now:`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text.trim();
}

module.exports = {
  generateOutreach,
  generateRoleJD,
  generateResumeFeedback,
  generateVictoryEmail,
  generateReply
};
