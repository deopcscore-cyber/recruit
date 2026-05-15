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

  const prompt = `You are ${user.name}, ${recruiterTitle} at Welltower Inc. A candidate has admitted their resume doesn't fully capture their experience. You need to write a detailed, warm, honest email that: praises what IS genuinely strong, identifies specific gaps, explains why it matters, and recommends they work with a professional resume consultant — then asks if they'd like an introduction.

GOLD STANDARD EXAMPLE (follow this exact structure and tone):
---
Dear Tomeka,

Thank you again for your interest in this opportunity and for being so transparent about your resume concerns. I actually appreciate that honesty quite a bit, because it confirms something I was already sensing while reviewing your background: the depth of your experience is significantly larger than what is currently being communicated on paper. And to be candid with you, that matters at this level.

What we genuinely like about your background at Welltower is that your experience is not one-dimensional. Very few candidates have operated across ownership, assisted living operations, home care leadership, elder care advising, member navigation, safety instruction, and patient-facing healthcare systems all within the same career journey. The fact that you personally owned and operated Wright Manor immediately gives your profile operational credibility that cannot be manufactured. That alone changes how leadership teams view your perspective.

We also like that your experience reflects direct exposure to both the clinical and non-clinical sides of senior care operations. Your work inside UnitedHealth/Optum adds payer-side and care coordination literacy that many senior living operators simply do not have. Combined with your CPR and safety instruction background, it paints the picture of someone who understands care environments from multiple operational angles rather than from a single department lens.

That said, after reviewing the resume carefully, I do see several areas that would likely need strengthening before going through a competitive executive-level screening process.

Right now, the document reads more like a generalized healthcare operations resume than the profile of someone who has led, built, influenced, and improved care environments across multiple sectors of senior services. Some of the most strategically valuable parts of your background are currently understated, compressed, or positioned in ways that do not fully communicate their executive relevance.

For example, the operational scope tied to Wright Manor feels much smaller on paper than I suspect it actually was in practice. The leadership complexity, accountability level, business ownership dimension, staffing oversight, compliance responsibilities, quality improvement impact, and community leadership authority are not yet carrying the weight they should. The same is true for parts of your home care and consulting background.

I also believe the narrative structure itself needs stronger alignment around portfolio-level leadership, operational transformation, and measurable organizational impact. At this stage, hiring teams are not simply looking for capable professionals — they are evaluating strategic influence, scale of responsibility, and executive-level operational judgment very quickly during early review.

And honestly, this is where many strong candidates unintentionally lose momentum. It is rarely because they lack experience. It is because the resume does not translate that experience into the language and positioning executive review teams are trained to respond to.

Because of that, I do not think this is something you should try to overhaul casually on your own, especially given the caliber and compensation level attached to this opportunity. The positioning has to be done carefully and strategically.

I would strongly recommend working with a professional resume consultant who understands executive healthcare and senior living positioning at this level. Someone who can help properly extract, frame, and elevate the operational leadership story that is already there — because I absolutely believe it is there.

If you are open to it, I would be happy to introduce you to a trusted consultant who has helped several candidates strengthen their presentation for opportunities like this. I genuinely believe having the right strategic presentation could make a very meaningful difference in how your background is received during review.

Let me know if you would like me to make that introduction.

${user.name}
${recruiterTitle} at Welltower™ Inc.
---

CANDIDATE INFORMATION:
${candidateInfo}

RESUME TEXT:
${candidate.resume.text.substring(0, 3000)}

INSTRUCTIONS — follow the gold standard structure exactly:
1. "Dear [First Name],"
2. Thank them for transparency — appreciate the honesty, it confirms what you were already sensing
3. "And to be candid with you, that matters at this level."
4. Paragraph: What Welltower genuinely LIKES about their background — be specific, name their actual companies/roles, highlight 2-3 genuinely impressive dimensions
5. Paragraph: Another specific strength (clinical + non-clinical, payer-side, unique combination, etc.) — reference their actual background
6. "That said, after reviewing the resume carefully, I do see several areas..."
7. Paragraph: The document currently reads as [describe the gap] — be specific, not generic
8. Paragraph: Give a concrete example — which section of their experience feels smaller on paper than it actually was, what's understated or compressed (reference their actual experience)
9. Paragraph: The narrative structure issue — hiring teams are evaluating quickly, executive-level positioning matters
10. Paragraph: "This is where many strong candidates unintentionally lose momentum..." — explain it's rarely about lack of experience, it's about how it's communicated
11. "Because of that, I do not think this is something you should try to overhaul casually on your own..." — explain why professional help is warranted
12. "I would strongly recommend working with a professional resume consultant..."
13. "If you are open to it, I would be happy to introduce you to a trusted consultant..."
14. "Let me know if you would like me to make that introduction."
15. Signature

Also return a brief internal gaps analysis. Output as valid JSON:
{
  "gaps": "A 2-3 sentence internal summary of the specific resume gaps you identified (for recruiter reference only)",
  "email": "The full email body following the gold standard structure above"
}

Return ONLY the JSON object, no markdown, no extra text.`;

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
  const firstName = (candidate.name || '').split(' ')[0];

  const prompt = `You are ${user.name}, ${recruiterTitle} at Welltower Inc. The candidate said yes to meeting Victory (the resume consultant). You are now writing the introduction email — addressed to the candidate but CC'ing Victory (victory@tobycareerconsults.com). This email must feel warm, specific, and urgent.

GOLD STANDARD EXAMPLE (follow this exact structure):
---
Dear Tomeka,

Wonderful, I'm glad you're open to the introduction.

I've CC'd Victory on this email. She is a trusted resume consultant I've worked with who has helped a number of candidates strengthen their positioning for high-level healthcare and senior living opportunities similar to this one.

Victory, I wanted to introduce you to Tomeka Wright.

Tomeka brings a genuinely unique and compelling background across senior living ownership, assisted living operations, home care leadership, elder care advisory, health plan navigation, and caregiver safety instruction. She previously owned and operated Wright Manor Assisted Living and has built a career centered around person-centered care, operational leadership, and improving outcomes across the senior care continuum.

After reviewing her resume and background, I believe there is substantially more executive-level operational value present than is currently being communicated on paper. In particular, I believe the strategic positioning, leadership narrative, operational scope, and portfolio-level impact need stronger framing to fully align with the caliber of opportunities she is being considered for.

Tomeka is very thoughtful, mission-driven, and clearly passionate about this work, and I believe with the right presentation strategy her background could become significantly more competitive in executive review environments.

Tomeka, I'll let you and Victory take it from here regarding timing, process, and next steps.

I do encourage both of you to prioritize this conversation sooner rather than later, as the early stages of review on these opportunities can move quickly once candidate materials begin entering formal consideration.

Looking forward to seeing this come together.

${user.name}
${recruiterTitle} at Welltower™ Inc.
---

CANDIDATE INFORMATION:
${candidateInfo}

INSTRUCTIONS — follow the gold standard structure exactly:
1. "Dear [First Name],"
2. "Wonderful, I'm glad you're open to the introduction."
3. "I've CC'd Victory on this email. She is a trusted resume consultant I've worked with who has helped a number of candidates strengthen their positioning for high-level healthcare and senior living opportunities similar to this one."
4. "Victory, I wanted to introduce you to [candidate full name]."
5. Paragraph to Victory about the candidate: summarize their background genuinely — name their actual companies, roles, and career arc. What makes their profile unique and compelling.
6. Paragraph about resume gap: "After reviewing her/his resume and background, I believe there is substantially more executive-level operational value present than is currently being communicated on paper. In particular, I believe the strategic positioning, leadership narrative, operational scope, and portfolio-level impact need stronger framing..."
7. Sentence about the candidate's character: "[Name] is very [specific quality observed from conversation], and I believe with the right presentation strategy their background could become significantly more competitive in executive review environments."
8. "Tomeka, I'll let you and Victory take it from here regarding timing, process, and next steps."
9. URGENCY: "I do encourage both of you to prioritize this conversation sooner rather than later, as the early stages of review on these opportunities can move quickly once candidate materials begin entering formal consideration."
10. "Looking forward to seeing this come together."
11. Signature

Output ONLY the email body (starting with "Dear ${firstName},"). No subject line, no commentary.

Write the introduction email now:`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text.trim();
}

async function generateReply(candidate, user, lastMessage) {
  const candidateInfo = formatCandidateContext(candidate);
  const recruiterTitle = (user.title && user.title.trim()) ? user.title.trim() : 'Senior Talent Acquisition Coordinator';

  const threadContext = (candidate.thread || []).map(msg => ({
    direction: msg.direction,
    subject: msg.subject,
    body: msg.body
  }));

  const lastMsg = lastMessage || (threadContext.length > 0 ? threadContext[threadContext.length - 1].body : '');
  const stepsCompleted = candidate.stepsCompleted || {};

  // ── Stage detection ──────────────────────────────────────────────────────
  let stageInstructions = '';

  if (!stepsCompleted.roleJD) {
    // STAGE 1: Candidate replied to outreach, JD not sent yet
    // → Quote their vision beautifully, pivot to "please review the JD below"
    stageInstructions = `
STAGE: FIRST REPLY AFTER OUTREACH — JD HAS NOT BEEN SENT YET

GOLD STANDARD for this stage (Jill → Tomeka after Tomeka's first reply):
---
Dear Tomeka,

Thank you for your beautifully expressed reply and for articulating your vision so clearly: ensuring the aging and disabled receive person-centered care with dignity, respect, and compassion. That is not a mission statement borrowed from a handbook. It is the conviction of someone who has built their entire professional life around it, from owning The Wright Manor to the work you continue today. I am glad this resonated.

Before we schedule time to connect, I'd like to kindly ask you to review the job description below. Please take a moment to consider whether this role aligns with your vision and career aspirations. If you feel it's a meaningful match, we can proceed and get a call on the calendar. If not, no worries at all, I'd be happy to explore other opportunities within the organization that may better align with where you want to make your impact. Looking forward to your feedback.

[ROLE DESCRIPTION BELOW]

${user.name}
${recruiterTitle} at Welltower™ Inc.
---

WRITE THIS STAGE FOLLOWING THIS EXACT STRUCTURE:
1. "Dear [First Name],"
2. Quote or closely paraphrase something specific they said about their vision, values, or motivation — elevate it: "That is not a mission statement borrowed from a handbook. It is the conviction of someone who has built their entire professional life around it, from [specific role/company in their background] to the work you continue today."
3. "I am glad this resonated."
4. "Before we schedule time to connect, I'd like to kindly ask you to review the job description below."
5. "Please take a moment to consider whether this role aligns with your vision and career aspirations. If you feel it's a meaningful match, we can proceed and get a call on the calendar. If not, no worries at all, I'd be happy to explore other opportunities within the organization that may better align with where you want to make your impact."
6. "Looking forward to your feedback."
7. "[ROLE DESCRIPTION BELOW]" — this placeholder tells the recruiter where to paste the JD
8. Signature

DO NOT ask for resume. DO NOT schedule a call. The JD review must come first.`;

  } else if (stepsCompleted.roleJD && !stepsCompleted.resumeRequested) {
    // STAGE 2: JD sent, candidate expressed interest / asked for scheduling
    // → "before we schedule, please send your resume" with positioning explanation
    stageInstructions = `
STAGE: JD SENT, CANDIDATE IS INTERESTED — REQUEST RESUME

GOLD STANDARD for this stage (Jill → Tomeka after Tomeka expressed interest in JD and offered availability):
---
Dear Tomeka,

Great to hear this resonates so strongly with you, that is always a very encouraging sign.

I would genuinely love to jump on a call with you and explore this further. Before we schedule time, though, there are a few details and questions I'd like to review first so I can make sure we position you as strongly as possible going into the process.

Could you send me your current resume when you have a moment?

There is an early screening step on these opportunities that can sometimes be stricter than people expect, and I have seen very strong candidates get overlooked simply because certain aspects of their leadership background, operational scope, or measurable impact were not coming through clearly enough on paper.

Given the depth and uniqueness of your background, from owning and operating The Wright Manor, to home care leadership, elder care advising, member navigation, and safety instruction, I want to make sure the full strength of your experience is being communicated in the clearest and most compelling way possible before anything formally moves forward.

Once I've had the chance to review it, I can advise you on next steps very quickly and we can move straight into scheduling time to connect.

Looking forward to seeing it, Tomeka.

${user.name}
${recruiterTitle} at Welltower™ Inc.
---

WRITE THIS STAGE FOLLOWING THIS EXACT STRUCTURE:
1. "Dear [First Name],"
2. Acknowledge their enthusiasm briefly — reference something specific they said (their phrasing about why it resonates, their availability they mentioned, their excitement)
3. "I would genuinely love to jump on a call with you and explore this further. Before we schedule time, though, there are a few details and questions I'd like to review first so I can make sure we position you as strongly as possible going into the process."
4. "Could you send me your current resume when you have a moment?"
5. Explain WHY (early screening step, strong candidates get overlooked when experience isn't communicated clearly on paper)
6. Reference their SPECIFIC background by name (actual companies and roles from their profile) — "from [specific ownership/company], to [other roles]"
7. "Once I've had the chance to review it, I can advise you on next steps very quickly and we can move straight into scheduling time to connect."
8. "Looking forward to seeing it, [First Name]."
9. Signature

DO NOT promise specific call times. DO NOT mention Victory or resume consultants yet.`;

  } else if (stepsCompleted.resumeReceived && !stepsCompleted.reviewSent) {
    // STAGE 3: Resume received — acknowledge receipt + ask 2 clarifying questions
    stageInstructions = `
STAGE: RESUME RECEIVED — ACKNOWLEDGE AND ASK TWO CLARIFYING QUESTIONS

GOLD STANDARD for this stage (Jill → Tomeka after Tomeka sent resume):
---
Dear Tomeka,

I've successfully received your resume, thank you for sending that over.

I'm currently reviewing your background against the specific operational leadership and portfolio-level requirements tied to this opportunity. My goal is to ensure your narrative fully bridges your hands-on senior care leadership experience with the type of strategic operational credibility these teams are looking for at the national portfolio level.

Before I finalize my internal assessment and prepare my recommendations for next steps, I wanted to clarify a couple of details to ensure we position you as strongly as possible:

• Recency: Is this the most current and fully updated version of your resume for an active executive-level opportunity?

• Comprehensive Scope: Does this version fully capture the breadth of your leadership journey and your most significant operational accomplishments to date — particularly your ownership responsibilities at Wright Manor, your home care leadership work, consulting scope, and any measurable growth, compliance, staffing, or care quality outcomes tied to those experiences?

I ask because backgrounds like yours are often much stronger in practice than what initially appears on paper, especially when someone has worn as many operational hats as you have across residential care, home care, member navigation, and caregiver education.

I want to ensure we are not leaving any valuable experience, leadership scope, or strategic impact understated before anything moves forward internally.

Once you confirm those details, I'll finalize my feedback and we can discuss the specific areas we may want to strengthen further to maximize how your background is received during early review.

Looking forward to hearing back from you, Tomeka.

${user.name}
${recruiterTitle} at Welltower™ Inc.
---

WRITE THIS STAGE FOLLOWING THIS EXACT STRUCTURE:
1. "Dear [First Name],"
2. "I've successfully received your resume, thank you for sending that over."
3. "I'm currently reviewing your background against the specific [type of requirements] tied to this opportunity. My goal is to ensure your narrative fully bridges your [specific type of experience] with the type of [strategic/operational/clinical] credibility these teams are looking for."
4. "Before I finalize my internal assessment and prepare my recommendations for next steps, I wanted to clarify a couple of details to ensure we position you as strongly as possible:"
5. TWO specific bullet questions:
   • Recency: Is this the most current and fully updated version?
   • Comprehensive Scope: Does it fully capture [reference their SPECIFIC background by name — actual companies, roles, accomplishments from their profile]?
6. "I ask because backgrounds like yours are often much stronger in practice than what initially appears on paper, especially when someone has [reference their specific multi-dimensional career path]."
7. "I want to ensure we are not leaving any valuable experience, leadership scope, or strategic impact understated before anything moves forward internally."
8. "Once you confirm those details, I'll finalize my feedback and we can discuss the specific areas we may want to strengthen further to maximize how your background is received during early review."
9. "Looking forward to hearing back from you, [First Name]."
10. Signature

DO NOT give resume feedback yet. DO NOT mention Victory or consultants yet.`;

  } else {
    // STAGE 4: General reply — context-appropriate
    stageInstructions = `
STAGE: GENERAL REPLY — respond appropriately based on the full conversation context

INSTRUCTIONS:
1. OPEN by quoting or closely paraphrasing something SPECIFIC from their last message — not generic
2. Address any specific things they mentioned (questions, concerns, timing, feedback)
3. Move the conversation naturally toward the next step
4. Warm, specific, human — not scripted`;
  }

  const prompt = `You are ${user.name}, ${recruiterTitle} at Welltower Inc., writing a reply to an executive candidate. This is a real ongoing conversation. Follow the gold standard and stage instructions below exactly.

CANDIDATE INFORMATION:
${candidateInfo}

CONVERSATION HISTORY (most recent last):
${JSON.stringify(threadContext, null, 2)}

MOST RECENT MESSAGE FROM CANDIDATE:
${lastMsg}

PIPELINE STATUS:
- Outreach sent: ${stepsCompleted.outreach ? 'Yes' : 'No'}
- Role JD sent: ${stepsCompleted.roleJD ? 'Yes' : 'No'}
- Resume requested: ${stepsCompleted.resumeRequested ? 'Yes' : 'No'}
- Resume received: ${stepsCompleted.resumeReceived ? 'Yes' : 'No'}
- Resume review sent: ${stepsCompleted.reviewSent ? 'Yes' : 'No'}
- Victory intro sent: ${stepsCompleted.victorySent ? 'Yes' : 'No'}
${stageInstructions}

CRITICAL RULES (all stages):
- NEVER open with "Thank you for getting back to me" or "I hope this finds you well" or any generic opener
- NEVER be vague — always reference their actual background, companies, and words
- Sound like a real human — warm, deliberate, specific
- Signature: ${user.name}\n${recruiterTitle} at Welltower™ Inc.
- Output ONLY the email body starting with "Dear [First Name]," — no subject line, no commentary

Write the reply now:`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 800,
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
