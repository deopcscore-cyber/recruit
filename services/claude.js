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

  const recruiterTitle = (user.title && user.title.trim()) ? user.title.trim() : 'Senior Talent Acquisition Coordinator';

  const prompt = `You are writing a personalized outreach email from a recruiter at Welltower Inc. to an executive candidate. You must follow the exact structure and tone of the example below — this is the gold standard.

GOLD STANDARD EXAMPLE (study the structure, tone, and flow carefully):
---
Dear Tomeka,

Your career in senior care is built on something most people in this field never have — you actually owned and operated an assisted living community. Running The Wright Manor from 2012 to 2016 means you understand what it takes to deliver care at the community level from the inside, not just from the advisory or referral side. From there you moved into senior placement and elder care advising, then into home care operations leadership at Wright Homecare Solutions, and more recently into member navigation at UnitedHealth Group and project management in home health — building a breadth of perspective across residential care, placement, home care operations, and health plan navigation that very few people in any single corner of the senior living world ever develop. Your CPR and health safety instruction practice, sustained for two decades alongside everything else, reflects someone who takes the care and safety dimensions of this work seriously at every level.

I'm reaching out on behalf of Welltower Inc. (NYSE: WELL) — a company that operates at a truly unique intersection: healthcare and real estate. We own and manage a global portfolio of senior housing communities, post-acute care facilities, and outpatient medical properties, and the work we do shapes how millions of people experience care and community as they age.

We're looking for senior care professionals who understand what it takes to operate a care environment — not just support one from the outside — and who bring the hands-on operational knowledge that comes from having run one. Your background across ownership, placement, home care operations, and health plan navigation gives you a grounded, practical view of the senior care ecosystem that translates well into the environments we manage.

If any of this resonates, feel free to reply here and I'd be happy to share more about what we're working on.

Jill Barror
Senior Talent Acquisition Coordinator at Welltower™ Inc.
---

RECRUITER STYLE:
${styleInfo}

CANDIDATE INFORMATION:
${candidateInfo}

STRICT STRUCTURE — follow this exactly, four paragraphs:

PARAGRAPH 1 — Career arc (the heart of the email):
- Open with "Dear [First Name]," on its own line, then a blank line
- First sentence: one sharp observation about what makes this person rare or distinctive — something most people in their field never have. Make it specific to THEIR actual background (ownership, unique operational experience, rare combination of roles, etc.)
- Continue by tracing their career chronologically — name specific companies, roles, and transitions in order, with dates where available. Show you actually read their background in detail.
- End paragraph 1 with one specific differentiating detail — a certification, sustained practice, or unique dimension of their work that reveals character or depth. Phrase it as a reflection of who they are.

PARAGRAPH 2 — Welltower introduction (use this almost verbatim every time):
"I'm reaching out on behalf of Welltower Inc. (NYSE: WELL) — a company that operates at a truly unique intersection: healthcare and real estate. We own and manage a global portfolio of senior housing communities, post-acute care facilities, and outpatient medical properties, and the work we do shapes how millions of people experience care and community as they age."

PARAGRAPH 3 — Bridge their background to Welltower's need:
- "We're looking for [type of professional that matches their background] who understand what it takes to [do the specific thing they've done] — not just support one from the outside — and who bring the hands-on [operational/strategic/clinical] knowledge that comes from having [done what they've done]."
- Follow with: "Your background across [their specific domains, named] gives you a [grounded/rare/distinctive] view of [the relevant ecosystem] that translates well into the environments we manage."

PARAGRAPH 4 — Soft CTA (use this exactly):
"If any of this resonates, feel free to reply here and I'd be happy to share more about what we're working on."

SIGNATURE (after one blank line):
${user.name}
${recruiterTitle} at Welltower™ Inc.

CRITICAL RULES:
- DO NOT mention any specific job title or role
- DO NOT end with "May I send over the details?" — use the soft CTA above
- DO NOT use generic openers like "I came across your profile" or "I'm impressed by your background"
- DO NOT use hollow phrases like "your impressive career" — be specific always
- Keep it under 300 words
- Sound like a real human being who genuinely read this person's background — warm, direct, specific
- Output ONLY the email body (starting with "Dear [First Name],") — no subject line, no commentary

Write the outreach email now:`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 800,
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
  const recruiterTitle = (user.title && user.title.trim()) ? user.title.trim() : 'Senior Talent Acquisition Coordinator';

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
  "email": "The email body asking if they are open to professional support — warm, specific, NOT generic. Do NOT mention 'Victory' or any specific service yet. Just ask if they'd be open to connecting with someone who specializes in executive positioning. Under 180 words. Sign as ${user.name}, ${recruiterTitle} at Welltower™ Inc."
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
  const recruiterTitle = (user.title && user.title.trim()) ? user.title.trim() : 'Senior Talent Acquisition Coordinator';

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
- Sign as: ${user.name}\n${recruiterTitle} at Welltower™ Inc.
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
  const recruiterTitle = (user.title && user.title.trim()) ? user.title.trim() : 'Senior Talent Acquisition Coordinator';

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
${recruiterTitle} at Welltower™ Inc.
9. Output ONLY the reply body. No subject line.

Write the reply now:`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text.trim();
}

async function scoreCandidate(candidate, user) {
  const candidateInfo = formatCandidateContext(candidate);

  const prompt = `You are a senior healthcare real estate recruiter at Welltower Inc. Score this executive candidate for fit with Welltower's strategic leadership needs.

CANDIDATE:
${candidateInfo}

Score them 1-10 on overall executive fit for Welltower (senior housing, healthcare REIT, data/innovation focus) and return ONLY a valid JSON object:
{
  "score": <integer 1-10>,
  "rationale": "<2-3 specific sentences about this candidate's fit, referencing their actual background>",
  "strengths": ["<strength 1>", "<strength 2>", "<strength 3>"],
  "concerns": ["<concern 1>", "<concern 2>"]
}

Score 8-10: exceptional fit (deep healthcare + strategic + executive). 5-7: solid fit with gaps. 1-4: significant gaps.
Return ONLY the JSON.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content[0].text.trim();
  const clean = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Could not parse score response');
  }
}

module.exports = {
  generateOutreach,
  generateRoleJD,
  generateResumeFeedback,
  generateVictoryEmail,
  generateReply,
  scoreCandidate
};
