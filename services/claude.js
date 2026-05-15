const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
Create a detailed, personalized role description that feels written specifically for this person. Use markdown formatting — headers (##), bold (**text**), bullet points (-). Structure it as six sections:

## [Role Title] — craft a specific title based on their background and Welltower's needs
**Welltower Inc. | Toledo, OH (Hybrid)**

---

## Why This Role Was Created With You In Mind
2-3 sentences that feel deeply personal — reference their actual companies, roles, and career transitions by name. Do not be generic.

---

## What You Will Own
8-10 bullet points covering strategic responsibilities, each tailored specifically to this candidate's background.

---

## What You Bring
8-10 bullet points mirroring their actual experience and strengths — reference real companies and roles they have held.

---

## Leadership Profile
3-4 sentences describing the kind of leader Welltower is looking for, written to match this candidate's demonstrated style.

---

## What Welltower Offers

**Compensation:** Base salary **$400,000 – $500,000** depending on experience, annual performance bonus targeting **30–40% of base**, long-term equity participation through Welltower stock grants (3-year vesting), and a full executive benefits package including healthcare, dental, vision, 401(k) with company match, and executive life insurance.

**Mission:** 2-3 sentences on Welltower's unique position at the healthcare-real estate intersection.

**Team:** 1-2 sentences on the collaborative, data-driven culture.

**Growth:** 1-2 sentences on the clear trajectory toward a Chief Strategy or Chief Healthcare Officer seat.

---

*Confidential | Prepared exclusively for [candidate first name]*

Make every section compelling and specific — not generic boilerplate. Reference their real background throughout. Output ONLY the role description, no additional commentary.

Write the role description now:`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text.trim();
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
8. End the reply with this exact signature on its own line:
${user.name}
Recruiter — Welltower Inc.
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
