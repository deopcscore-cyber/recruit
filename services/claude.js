const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Lazy-init OpenAI so a missing key doesn't crash the server at startup
let _openai = null;
function getOpenAI() {
  if (!_openai) {
    const { default: OpenAI } = require('openai');
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const OPENAI_MODEL = 'gpt-4o-mini';

// Cost per million tokens in cents
const CLAUDE_IN  = 300;   // $3.00
const CLAUDE_OUT = 1500;  // $15.00
const OPENAI_IN  = 15;    // $0.15
const OPENAI_OUT = 60;    // $0.60

function _isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Parse a model response that's supposed to be JSON. Models reliably produce
// a small number of malformed spots at this output size — an unescaped
// double-quote inside a long generated sentence, a response cut short by the
// token budget — and a bare JSON.parse has no recovery from either. Escalates
// through three attempts before giving up: (1) strict parse after stripping
// any ```json fence, (2) strict parse of just the outermost {...} block in
// case there's leading/trailing prose around it, (3) jsonrepair on that same
// block, which specifically fixes unescaped quotes and truncated structures.
// Every schema we ask for is a top-level object, so any attempt whose result
// isn't a plain object is treated as a failure too — jsonrepair will happily
// "repair" a plain-English refusal like "Sorry, I can't help with that" into
// a valid-but-meaningless JSON array of words, which must not be accepted as
// a good parse. Throws (with the original text attached) if nothing works —
// callers decide their own fallback.
function parseAIJson(raw) {
  const clean = (raw || '').replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  const candidate = match ? match[0] : clean;

  for (const str of [clean, candidate]) {
    try {
      const val = JSON.parse(str);
      if (_isPlainObject(val)) return val;
    } catch { /* try the next tier */ }
  }
  try {
    const { jsonrepair } = require('jsonrepair');
    const val = JSON.parse(jsonrepair(candidate));
    if (_isPlainObject(val)) return val;
  } catch { /* fall through to the throw below */ }

  const err = new Error('Could not parse model response as JSON — expected a JSON object.');
  err.rawText = raw;
  throw err;
}

function calcCostCents(usage, provider) {
  if (!usage) return 0;
  const inp = usage.input_tokens  || 0;
  const out = usage.output_tokens || 0;
  const inRate  = provider === 'openai' ? OPENAI_IN  : CLAUDE_IN;
  const outRate = provider === 'openai' ? OPENAI_OUT : CLAUDE_OUT;
  return Math.ceil((inp * inRate + out * outRate) / 1_000_000);
}

function appendInstructions(prompt, instructions) {
  if (!instructions || !instructions.trim()) return prompt;
  const text = instructions.trim();
  // Sandwich the sender's instructions: a brief at the TOP (models weight the
  // start of a prompt heavily and the template that follows is long), plus the
  // override + a forced self-check at the BOTTOM. Framed as an override, not a
  // suggestion — the templates are full of "follow this exact structure"
  // directives that a soft "additional note" gets steamrolled by.
  const brief = `SENDER'S BRIEF FOR THIS EMAIL — READ FIRST.
The sender typed the following instructions for THIS specific email. The
template further below is default scaffolding; where they conflict, this
brief wins. Treat EVERY sentence below as a separate requirement that must
be visibly fulfilled in the finished email — if a sentence asks you to
explain reasons ("why"), the email must actually state those reasons
concretely; if it dictates how to close, the email must close that way:
"""
${text}
"""

`;
  return brief + prompt + `

═══════════════════════════════════════════
OVERRIDE — SENDER'S INSTRUCTIONS FOR THIS EMAIL (highest priority; same
brief as at the top of this prompt)
Everything above (structure, examples, numbered steps, "critical rules") is
a default starting point. The instructions below are what the sender
actually asked for THIS TIME. Where they conflict with anything above,
follow the instructions below instead — do not silently keep the default
structure. Apply them concretely (if they ask for urgency, the sentences
must read as urgent, not just add a word "urgent" somewhere; if they ask
to mention something, mention it plainly, not vaguely).
TWO THINGS SURVIVE EVERY INSTRUCTION unless the instructions explicitly
say to drop them: (1) if this is a first contact or the template includes
introducing the sender/company, the email must still make clear who is
writing and where from — even a "make it shorter" email keeps a one-line
introduction; (2) if the conversation context includes a latest message
from the candidate, the email still acknowledges and responds to it:
"""
${text}
"""
FINAL CHECK before you answer: go through the sender's instructions
sentence by sentence. For each one, confirm the draft contains the
sentence(s) that fulfil it — explicitly, not by vague implication. If any
requirement is missing or only half-done, rewrite the draft first, then
output only the final email in the format this prompt requires.
═══════════════════════════════════════════`;
}

// Which provider runs first for this user. Explicit setting wins; otherwise
// consultants default to Claude (writing quality) and recruiters to OpenAI (cost).
function prefersClaude(user) {
  if (user?.aiProvider === 'claude') return true;
  if (user?.aiProvider === 'openai') return false;
  return user?.userType === 'career_consultant';
}

// Provider for a single generation. Custom sender instructions demand real
// instruction-following, which the cheap default model reliably fumbles
// (it half-applies multi-part instructions) — route those to Claude even for
// users who default to OpenAI. Cost is passed through credits either way.
function pickProvider(user, instructions) {
  return prefersClaude(user) || !!(instructions && instructions.trim());
}

// Try OpenAI first; fall back to Claude on error
// finishReason lets callers tell "the model got cut off by maxTokens" apart
// from "the model finished normally but produced something unusable" —
// 'length' (OpenAI) / 'max_tokens' (Claude) means the former.
async function callAI(prompt, maxTokens, preferClaude = false) {
  if (preferClaude) {
    // Claude first, OpenAI fallback — used for career consultant profiles
    try {
      const res = await anthropic.messages.create({
        model: CLAUDE_MODEL, max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      });
      return { content: res.content, usage: res.usage, provider: 'claude', finishReason: res.stop_reason };
    } catch (err) {
      console.warn('[AI] Claude unavailable, switching to OpenAI:', err.message);
    }
    const res = await getOpenAI().chat.completions.create({
      model: OPENAI_MODEL, max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    });
    return {
      content: [{ text: res.choices[0].message.content }],
      usage: { input_tokens: res.usage.prompt_tokens, output_tokens: res.usage.completion_tokens },
      provider: 'openai',
      finishReason: res.choices[0].finish_reason
    };
  }

  // Default: OpenAI first, Claude fallback
  if (process.env.OPENAI_API_KEY) {
    try {
      const res = await getOpenAI().chat.completions.create({
        model: OPENAI_MODEL, max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      });
      return {
        content: [{ text: res.choices[0].message.content }],
        usage: { input_tokens: res.usage.prompt_tokens, output_tokens: res.usage.completion_tokens },
        provider: 'openai',
        finishReason: res.choices[0].finish_reason
      };
    } catch (err) {
      console.warn('[AI] OpenAI unavailable, switching to Claude:', err.message);
    }
  }

  const res = await anthropic.messages.create({
    model: CLAUDE_MODEL, max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }]
  });
  return { content: res.content, usage: res.usage, provider: 'claude', finishReason: res.stop_reason };
}

// ─── Company context helper ───────────────────────────────────────────────────
// Each user sets their own company name & pitch in Settings → Account.
// These replace every hardcoded "Welltower Inc." reference in the AI prompts,
// making the platform work for any recruiter at any company.
function getCompanyContext(user) {
  const name        = (user.companyName  || '').trim() || 'our company';
  const pitch       = (user.companyPitch || '').trim() ||
    `I'm reaching out on behalf of ${name} — we're looking for experienced professionals who can make an impact at the leadership level.`;
  const salaryRange = (user.salaryRange  || '').trim();
  return { name, pitch, salaryRange };
}

function formatCandidateContext(candidate) {
  const lines = [];
  lines.push(`Name: ${candidate.name || 'Unknown'}`);
  if (candidate.title) lines.push(`Current Title: ${candidate.title}`);
  if (candidate.company) lines.push(`Current Company: ${candidate.company}`);
  if (candidate.location) lines.push(`Location: ${candidate.location}`);
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

// Recent conversation + the candidate's latest message, formatted for prompts.
// Used by every mid-pipeline generator so the email responds to what the
// candidate actually said instead of opening from a template. Returns '' for
// an empty thread so prompts degrade gracefully.
function formatConversationContext(candidate, maxMessages = 6) {
  const msgs = (candidate.thread || [])
    .filter(m => m.direction === 'inbound' || m.direction === 'outbound')
    .slice(-maxMessages)
    .map(m => ({ from: m.direction === 'inbound' ? 'candidate' : 'you', body: (m.body || '').slice(0, 1500) }));
  if (!msgs.length) return '';
  const lastInbound = [...(candidate.thread || [])].reverse().find(m => m.direction === 'inbound');
  let block = `CONVERSATION SO FAR (most recent last):
${JSON.stringify(msgs, null, 2)}
`;
  if (lastInbound) {
    block += `
THE CANDIDATE'S LATEST MESSAGE (your email must acknowledge and respond to this — reference their actual words, answer their questions, and work with any constraints or concerns they raised; do not open with a generic line that ignores it):
"""
${(lastInbound.body || '').slice(0, 2000)}
"""
`;
  }
  return block;
}

// If the user provided a subject line sample, return a prompt instruction
// to mirror its style (length, tone, specificity) for the generated subject.
function subjectGuidance(user) {
  const s = (user && user.subjectSample || '').trim();
  if (!s) return '';
  return `\nSUBJECT LINE STYLE: Mirror the style of this example subject the sender provided — match its length, tone, and level of specificity. Do NOT copy it verbatim; write a fresh one for this person:\nExample: "${s}"\n`;
}

// If the user provided an outreach sample, return a prompt block telling the
// model to match their VOICE (tone/personality/rhythm) for messages that aren't
// the cold outreach itself — follow-ups, replies. We borrow voice, not structure,
// because those messages serve a different purpose than the original sample.
function voiceGuidance(user) {
  const s = (user && user.outreachSample || '').trim();
  if (s.length < 40) return '';
  return `\nWRITE IN THE SENDER'S VOICE. Below is a sample of how this sender naturally writes — match its tone, warmth, personality and rhythm. Do NOT copy its words or its structure (this message has a different purpose); just sound like the same person wrote it:\n"""\n${s.slice(0, 1500)}\n"""\n`;
}

async function generateOutreach(candidate, user, instructions) {
  // If the user provided a sample of how their outreach should look, match that
  // style instead of a built-in template — keeps every user's emails distinct.
  if (user.outreachSample && user.outreachSample.trim().length > 40) {
    return _generateFromSample(candidate, user, instructions);
  }
  // Route to the right prompt based on the user's account type
  const type = user.userType || 'recruiter_company';
  if (type === 'career_consultant')      return _generateCareerConsultantOutreach(candidate, user, instructions);
  if (type === 'recruiter_independent')  return _generateIndependentRecruiterOutreach(candidate, user, instructions);
  return _generateCompanyRecruiterOutreach(candidate, user, instructions);
}

// ── Style-matched outreach from a user-provided sample ────────────────────────
// The user pastes an example email they like; we mirror its voice, structure,
// tone and length, but write fresh content for THIS candidate.
async function _generateFromSample(candidate, user, instructions) {
  const candidateInfo = formatCandidateContext(candidate);
  const company       = getCompanyContext(user);
  const firstName     = (candidate.name || '').trim().split(/\s+/)[0];
  const sample        = user.outreachSample.trim().slice(0, 2500);

  const prompt = `You are ${user.name || 'the sender'}${company.name ? ' at ' + company.name : ''}, writing a cold outreach email to the person below.

The sender gave you a SAMPLE that represents EXACTLY the voice, tone, structure, paragraph count and length they want. Your job is to write a NEW email for THIS specific person that feels like it came from the same author as the sample — same rhythm, same personality, same format — but with content written fresh for this candidate.

SAMPLE TO MATCH (mirror its style, NOT its specific content):
"""
${sample}
"""

${company.name || company.pitch ? `SENDER CONTEXT:\n${company.name ? 'Company: ' + company.name + '\n' : ''}${company.pitch ? 'About: ' + company.pitch : ''}\n` : ''}
THE PERSON YOU'RE WRITING TO:
${candidateInfo}

RULES:
- Match the sample's TONE, STRUCTURE, PARAGRAPH COUNT, and approximate LENGTH closely.
- Do NOT copy sentences from the sample verbatim and do NOT reuse its names, companies, or specific details — reproduce its FEEL, not its words.
- Personalize the actual content to THIS person: reference their real companies, roles, and career details from the info above.
- Vary the wording naturally so two different candidates never get near-identical emails.
- If the sample has a signature/sign-off, leave it out — the sender's signature is appended automatically.
- Output as JSON with two fields: { "subject": "...", "body": "..." }. ${subjectGuidance(user) || 'The subject should match the style of the sample\'s subject if it has one, otherwise write a short specific one.'} Body starts with the greeting (e.g. "Dear ${firstName}," or whatever greeting style the sample uses).

Output ONLY valid JSON. No markdown, no commentary.`;

  const response = await callAI(appendInstructions(prompt, instructions), 1000, pickProvider(user, instructions));
  const raw = response.content[0].text.trim();
  const costCents = calcCostCents(response.usage, response.provider);
  try {
    const parsed = parseAIJson(raw);
    return { text: parsed.body || parsed.text || raw, subject: parsed.subject || '', costCents };
  } catch {
    return { text: raw, subject: '', costCents };
  }
}

// ── Career Consultant outreach ────────────────────────────────────────────────
// "I see your potential — let me help you get to a better position."
async function _generateCareerConsultantOutreach(candidate, user, instructions) {
  const candidateInfo   = formatCandidateContext(candidate);
  const styleInfo       = formatUserStyle(user);
  const consultantName  = user.name || 'Your Consultant';
  const consultantTitle = (user.title && user.title.trim()) || 'Career Strategist';
  const practiseName    = (user.companyName || '').trim() || '';
  // Extract first name correctly — handle multi-word names
  const firstName = (candidate.name || '').trim().split(/\s+/)[0];

  const prompt = `You are ${consultantName}${practiseName ? ' at ' + practiseName : ''}. You are writing a cold outreach email to a professional whose LinkedIn profile you came across. You noticed something specific about their career story that most people would miss.

IMPORTANT CONTEXT: This is a FIRST email. You are NOT pitching a service in this email. You are NOT mentioning career coaching, resume writing, or anything you sell. You are simply a person who read their profile carefully and noticed something worth sharing. The goal of this email is ONE thing: get a reply.
${styleInfo ? '\nSTYLE GUIDANCE:\n' + styleInfo + '\n' : ''}
CANDIDATE INFORMATION:
${candidateInfo}

Write a 3-paragraph email. Follow this structure EXACTLY:

PARAGRAPH 1 — Open with the specific thing you noticed (2-3 sentences):
- Address them as "Dear ${firstName},"
- Dive straight into the observation itself — talk about THEIR career, not about you noticing it.
- BANNED OPENERS (these scream "AI template"): "What caught my attention...", "What stood out to me...", "I noticed that...", "I was impressed by...", "Your background caught my eye...". Never open by describing your own act of noticing.
- Instead, open with the fact itself. Examples of natural openers:
  - "Thirteen years inside one ecosystem — Amerigroup to Elevance — and somehow you've held six genuinely different jobs in that time."
  - "Most people who start in payroll stay in payroll. You ended up running comp, benefits, and HRIS for an entire company."
  - "Going from [X] to [Y] without leaving [Company] is a harder move than it looks from the outside."
- Reference real companies, real roles, real transitions by name. Vary the structure — a short punchy first sentence works well.

TARGET & PSYCHOLOGY — read this carefully:
The people you write to are successful and well-paid. They are NOT looking for help and do not think they have a problem. Your job is NOT to flatter them and NOT to insult them. Your job is to surface a GAP they can feel once you name it: the distance between what they have actually built and the level / recognition / compensation their current seat reflects. The core message underneath every email is "someone with your track record should be operating a level above where you are — and the only reason you're not is how your story is positioned, not your ability." You make them feel they deserve better than where they are right now.

PARAGRAPH 2 — Name the gap they can feel (2-3 sentences):
- This is the most important paragraph. Do NOT tease. Deliver a specific, real observation that creates a productive dissatisfaction — the contrast between their actual scope/impact and the level or comp their current title reflects.
- Frame it as untapped value and an undeserved ceiling, never as a flaw. The subtext: "you've outgrown your current seat and probably know it."
- Be specific to THEIR background — name the real transition, role, or scope. Make it land as insight, not a pitch.
- Example: "Here's what stands out: you're doing genuine VP-level work — owning comp, benefits and HRIS across the whole company — but the title and the way it reads still say 'Director.' People with your actual scope are usually operating a level up and paid accordingly. The gap isn't your ability; it's that your story is positioned for the job you have, not the one you've already outgrown."
- Do NOT say "your resume is weak." Say: you're worth more than your current seat reflects.

PARAGRAPH 3 — Close with a question that probes the discontent (2 sentences max):
- Do NOT mention career coaching, resume services, or anything you sell.
- Do NOT ask for a call, meeting, or "connect."
- Do NOT say "reply if you want my thoughts" — you already gave a real one above.
- End with ONE direct, genuinely curious question that gently opens the gap between where they are and where they could be — easy to answer in a single line, almost rude not to answer.
- Good question styles (pick what fits their situation):
  - "Does your current title and comp actually reflect the scope you're carrying — or does it feel like you've outgrown the seat?"
  - "Are you where you expected to be by now, or does it feel like the role hasn't caught up to what you're actually doing?"
  - "If the right thing came along at the next level up, would you be open to it — or are you fully settled where you are?"
- The goal: a question that makes them pause and quietly admit "...actually, no, it doesn't."

RULES:
- Do NOT add a signature, sign-off name, title, or company at the end — the sender's email signature is appended automatically. End the email after the question in paragraph 3.
- Under 200 words total — short emails get read, long emails get deleted
- Do NOT mention career coaching, consulting, resume writing, or any service you offer
- Do NOT use numbers like "helped 2,000 professionals" — that's marketing copy, not a human
- Do NOT use phrases like "exciting opportunity", "I came across your profile", "no obligation", "quick call"
- Sound like a real person who genuinely read their background — direct, curious, warm but not salesy
- The email must end with a question mark
- The email should feel written specifically for this one person, not templated
- Output as JSON with two fields: { "subject": "...", "body": "..." }
- subject: a short, specific subject line that references something real about their background — NOT generic.${subjectGuidance(user) || ' Examples: "Your path from X to Y", "A thought on your compliance transition", "Something I noticed about your background at [Company]"'}
- body: the full email body starting with "Dear ${firstName},"

Output ONLY valid JSON. No markdown, no extra text.

Write the email now:`;

  const response = await callAI(appendInstructions(prompt, instructions), 900, pickProvider(user, instructions));
  const raw = response.content[0].text.trim();
  const costCents = calcCostCents(response.usage, response.provider);
  try {
    const parsed = parseAIJson(raw);
    return { text: parsed.body || parsed.text || raw, subject: parsed.subject || '', costCents };
  } catch {
    // Fallback: treat whole response as body text
    return { text: raw, subject: '', costCents };
  }
}

// ── Independent Recruiter outreach ────────────────────────────────────────────
// "I place talent across multiple companies — your background fits what my clients need."
async function _generateIndependentRecruiterOutreach(candidate, user, instructions) {
  const candidateInfo = formatCandidateContext(candidate);
  const styleInfo     = formatUserStyle(user);
  const recruiterName = user.name || 'Recruiter';
  const recruiterTitle = (user.title && user.title.trim()) || 'Executive Recruiter';
  const agencyName    = (user.companyName || '').trim() || '';
  const pitch         = (user.companyPitch || '').trim() ||
    'I work with a select group of growing companies — typically well-funded or well-established — that are looking for experienced operators who have actually done the work, not just managed the process.';

  const prompt = `You are ${recruiterName}, an independent executive recruiter${agencyName ? ' at ' + agencyName : ''}. You are NOT writing on behalf of one specific company — you place talent across multiple client companies. You are reaching out to a candidate whose background is a strong fit for the type of roles you typically fill.

YOUR PITCH:
${pitch}

CANDIDATE INFORMATION:
${candidateInfo}

STYLE GUIDANCE:
${styleInfo}

Write a 4-paragraph outreach email following this structure EXACTLY:

PARAGRAPH 1 — Career arc (the heart of the email):
- "Dear [First Name],"
- One sharp, specific observation about what makes this person rare — something most people in their field never develop. Reference real companies and roles.
- Trace their career arc, naming specific companies and transitions chronologically.
- End with one differentiating detail that reveals depth or character.

PARAGRAPH 2 — Who you are / your positioning (REQUIRED — never omit this paragraph; this is a cold email and the reader must learn who is writing and why):
- Explain briefly that you are an independent recruiter, not tied to one company.
- Use the pitch above, lightly adapted for natural flow.
- The key message: you bring opportunities from multiple companies and you are selective about who you bring them to.

PARAGRAPH 3 — Bridge their background to your clients' needs:
- "The companies I work with are specifically looking for [type of professional that matches the candidate] who understand [specific thing the candidate has done] from the inside — not just in a support or advisory function."
- "Your background across [specific domains] is the kind of profile that travels well across [the relevant industry]."

PARAGRAPH 4 — Curiosity CTA:
- Do NOT say "I have an exciting opportunity." Do NOT ask for a call upfront.
- "There is a specific situation I have in mind — I kept the details out of this note on purpose because context matters, and I'd rather share them in a reply than cold-drop a job description. If any part of this caught your attention, reply here and I'll send the specifics. No calls to schedule, no commitments."

SIGNATURE:
${recruiterName}
${recruiterTitle}${agencyName ? '\nIndependent Recruiter' : ''}

RULES:
- DO NOT name a specific client company
- DO NOT use phrases like "I came across your profile" or "exciting opportunity"
- Sound warm, specific, human — under 300 words
- Output ONLY the email body starting with "Dear [First Name],"

Write the email now:`;

  const response = await callAI(appendInstructions(prompt, instructions), 800, pickProvider(user, instructions));
  return { text: response.content[0].text.trim(), costCents: calcCostCents(response.usage, response.provider) };
}

// ── Company Recruiter outreach (original) ─────────────────────────────────────
async function _generateCompanyRecruiterOutreach(candidate, user, instructions) {
  const candidateInfo = formatCandidateContext(candidate);
  const styleInfo = formatUserStyle(user);
  const company = getCompanyContext(user);

  const recruiterTitle = (user.title && user.title.trim()) ? user.title.trim() : 'Senior Talent Acquisition Coordinator';

  const prompt = `You are writing a personalized outreach email from a recruiter at ${company.name} to an executive candidate. You must follow the exact structure and tone of the example below — this is the gold standard.

GOLD STANDARD EXAMPLE (study the structure, tone, and flow carefully):
---
Dear Tomeka,

Your career in senior care is built on something most people in this field never have — you actually owned and operated an assisted living community. Running The Wright Manor from 2012 to 2016 means you understand what it takes to deliver care at the community level from the inside, not just from the advisory or referral side. From there you moved into senior placement and elder care advising, then into home care operations leadership at Wright Homecare Solutions, and more recently into member navigation at UnitedHealth Group and project management in home health — building a breadth of perspective across residential care, placement, home care operations, and health plan navigation that very few people in any single corner of the senior living world ever develop. Your CPR and health safety instruction practice, sustained for two decades alongside everything else, reflects someone who takes the care and safety dimensions of this work seriously at every level.

${company.pitch}

We're looking for senior care professionals who understand what it takes to operate a care environment — not just support one from the outside — and who bring the hands-on operational knowledge that comes from having run one. Your background across ownership, placement, home care operations, and health plan navigation gives you a grounded, practical view of the senior care ecosystem that translates well into the environments we manage.

If any of this resonates, feel free to reply here and I'd be happy to share more about what we're working on.

Jill Barror
Senior Talent Acquisition Coordinator at ${company.name}
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

PARAGRAPH 2 — Company introduction (REQUIRED — never omit this paragraph; this is a cold email and the reader must learn who is reaching out and from where. Use the recruiter's company pitch below — adapt slightly for natural flow but keep the core message):
"${company.pitch}"

PARAGRAPH 3 — Bridge their background to the company's need:
- "We're looking for [type of professional that matches their background] who understand what it takes to [do the specific thing they've done] — not just support one from the outside — and who bring the hands-on [operational/strategic/clinical] knowledge that comes from having [done what they've done]."
- Follow with: "Your background across [their specific domains, named] gives you a [grounded/rare/distinctive] view of [the relevant ecosystem] that translates well into the environments we manage."

PARAGRAPH 4 — Curiosity CTA (use this structure — make them want to know more):
Do NOT use the passive "If any of this resonates." Instead, create a knowledge gap that makes them curious about what you haven't told them yet. Structure it like this:
- One sentence that hints there is something specific you deliberately left out of this email — something that "lands differently once you see the full picture" or that is "easier to show than describe"
- Then the ask: "If any part of this caught your attention — even just part of it — reply here and I'll send it over."
- Then remove all friction: "No calls to schedule, no forms — just a reply."
Example: "There is one part of what we are building right now that I kept out of this email on purpose — the kind of detail that is easier to show than describe, and that I think lands differently once you see the full picture. If any part of this caught your attention, reply here and I will send it over. No calls to schedule, no commitments — just a reply."

SIGNATURE (after one blank line):
${user.name}
${recruiterTitle} at ${company.name}

CRITICAL RULES:
- DO NOT mention any specific job title or role
- DO NOT end with "May I send over the details?" — use the soft CTA above
- DO NOT use generic openers like "I came across your profile" or "I'm impressed by your background"
- DO NOT use hollow phrases like "your impressive career" — be specific always
- Keep it under 300 words
- Sound like a real human being who genuinely read this person's background — warm, direct, specific
- Output ONLY the email body (starting with "Dear [First Name],") — no subject line, no commentary

Write the outreach email now:`;

  const response = await callAI(appendInstructions(prompt, instructions), 800, pickProvider(user, instructions));

  return { text: response.content[0].text.trim(), costCents: calcCostCents(response.usage, response.provider) };
}

// Builds the JSON schema instructions for one role variant, reused for both
// the "current level" and "step up" variants so their structure stays
// identical (only the seniority/scope differs).
function _roleVariantSchemaBlock(label, angle) {
  return `{
  "variantLabel": "${label}",
  "title": "role title matching this angle: ${angle} — formatted like a real corporate posting title, e.g. \\"VP, Construction & Development\\"",
  "employmentType": "Full-Time (or what fits)",
  "workMode": "On-site, Hybrid, or Remote — whichever fits the role and the candidate's location",
  "companyIntro": {
    "headline": "an all-caps company banner headline, e.g. \\"ACME — REIMAGINE SENIOR CARE WITH US\\"",
    "body": "2 substantial paragraphs (separated by \\\\n\\\\n), each 3-5 full sentences, selling the company's mission, culture, and ambition in a confident careers-page voice, drawn from the company pitch. Include a short mantra-style line if it fits naturally (e.g. a phrase that captures the company's operating philosophy). End with a sentence about the kind of person the company wants."
  },
  "summary": "2 dense paragraphs (separated by \\\\n\\\\n), each 4-6 full sentences, describing the role's mandate, scope, where it sits in the organization, who it partners with, and why it matters right now — written so this candidate's real background is obviously the profile it calls for, but phrased like a genuine posting (never name the candidate)",
  "responsibilityGroups": [
    { "heading": "thematic subheading, e.g. \\"Strategic Leadership\\"", "bullets": ["3-6 responsibility bullets for this theme, each a complete, detailed sentence (20-35 words) — not a short fragment"] },
    { "heading": "…6 to 8 groups total, covering the full scope of the role end-to-end (e.g. strategic leadership, a domain-specific execution group, cross-functional/partner coordination, team leadership & management, quality/compliance, process improvement & innovation) — themes chosen to fit this role and showcase this candidate's strengths in depth, not just breadth", "bullets": ["…"] }
  ],
  "requirements": ["8-10 bullets, each a complete, detailed sentence (not a short fragment): education, years of experience, domain expertise, specific tools/software, track record on deals or projects of a certain size, certifications — written so THIS candidate clearly meets every one (mirror their actual years, domains, scope, and transitions) but phrased as a genuine public posting: never name the candidate or their employers"],
  "whatWeOffer": ["6-8 bullets. FIRST bullet is compensation for this role's level (base range + bonus/equity, positioned above what their current seat would typically pay); then benefits and perks in the company's voice — PTO, stock purchase or equity program, retirement matching, tuition/professional development, health benefits, and any other perks that fit"]
}`;
}

async function generateRoleJD(candidate, user, instructions) {
  const candidateInfo = formatCandidateContext(candidate);
  const styleInfo = formatUserStyle(user);
  const company = getCompanyContext(user);
  const firstName = (candidate.name || '').trim().split(/\s+/)[0] || 'there';

  // Derive a readable location for the JD header
  const candidateLocation = (candidate.location || '').trim();
  const jdLocation = candidateLocation ? candidateLocation : 'Remote / Hybrid';

  const convoContext = formatConversationContext(candidate);

  const prompt = `You are ${user.name}, writing to an executive candidate at ${company.name}. You are producing TWO things at once: (1) a short personal email, and (2) ONE tailored role description — a clear step up from the candidate's current level — that will be attached as a PDF (referenced from the email, not pasted into it).

RECRUITER STYLE:
${styleInfo}

CANDIDATE INFORMATION:
${candidateInfo}
${convoContext ? '\n' + convoContext + '\n' : ''}
═══════════════════════════════════════════
PART 1 — THE EMAIL BODY
═══════════════════════════════════════════
GOLD STANDARD EXAMPLE (follow this exact structure and tone — adapt to this specific candidate, don't copy wording verbatim):
---
Dear ${firstName},

I'm thrilled to hear that you're interested in connecting further! Your experience as [their actual title] at [their actual company], coupled with [a specific real detail from their background], positions you uniquely to contribute meaningfully to ${company.name}'s mission. I'm eager to explore how your skills and insights can align with our objectives.

To keep the momentum going, I've attached the role description I have in mind for you. I'll be upfront: it's a step up from where you are today — deliberately so, because I think your background has outgrown your current seat. Please take a moment to read it and consider whether it aligns with your vision and where you want to make your next move. Even a one-line reaction helps me understand where you stand.

[ROLE DESCRIPTION ATTACHED]

And if, after reading it, you feel this kind of step isn't what you're ready for right now — just tell me. That's genuinely useful to know, and we may well have something else that fits you better.

Looking forward to hearing your thoughts!
---

RULES FOR THE EMAIL BODY:
1. If there is a candidate conversation above, the opening paragraph MUST directly acknowledge and respond to their latest message — reference their actual words, answer anything they asked, don't ignore it and open generically. If there's no conversation yet (first time sending a JD), open warmly referencing their actual background instead.
2. Mention that you've attached ONE role description and be upfront that it represents a step up from their current level.
3. REQUIRED, near the end: tell them plainly that if they don't feel ready for this kind of step, they should let you know — you may have something else for them. Keep it warm and pressure-free (their honesty helps you), never condescending.
4. Keep total length similar to the example — do not pad it out.
5. Include the literal line "[ROLE DESCRIPTION ATTACHED]" on its own line where the attachment would be referenced.
6. Do NOT add a signature, sign-off name, title, or company at the end — the sender's email signature is appended automatically. End right after "Looking forward to hearing your thoughts!" or equivalent.
7. ${styleInfo ? 'Follow the style guidance above.' : 'Warm, professional, not salesy.'}

═══════════════════════════════════════════
PART 2 — THE ROLE DESCRIPTION (for the attached PDF)
═══════════════════════════════════════════
"Your Next Step": a role one clear level above their current title/scope — same functional area, meaningfully more scope/seniority/ownership — so it reads as an aspirational but credible next move, not a fantasy leap.
Write it in the style of an official corporate careers-site posting (like a Fortune-500 job page): confident, polished, impersonal in voice. The tailoring is invisible: the summary, responsibility themes, and requirements are engineered from this candidate's REAL background (their years, domains, scope, transitions) so they will recognise themselves in every line and clearly qualify — but the document itself never names the candidate or their employers. Never generic boilerplate.
LENGTH AND DEPTH — this must read as a genuine, thorough corporate job posting, not a summary of one. Real postings at this level run 700-1200+ words across many responsibility groups with detailed, full-sentence bullets, a dense multi-paragraph summary, and a long requirements list. Err toward MORE detail and MORE groups/bullets rather than less — a thin, sparse-feeling document is a failure here. Follow the bullet/group counts in the schema below as a floor, not a ceiling.
${company.salaryRange ? `Company's general salary range for context (use as a loose anchor, positioned for the step-up level): ${company.salaryRange}.` : ''}

═══════════════════════════════════════════
OUTPUT FORMAT — valid JSON only, no markdown fences, no commentary:
═══════════════════════════════════════════
JSON SAFETY (this is machine-parsed — a single violation breaks the whole response):
- Every double-quote character (") inside any text value MUST be escaped as \\". Simpler: avoid literal " inside text entirely — use single quotes ' instead if you want to quote something.
- Never use smart/curly quotes ("  "  '  ') anywhere — straight quotes only, and only where JSON syntax requires them.
- Paragraph breaks inside a string are the two-character escape sequence \\n\\n, never a literal newline.
- No trailing commas after the last item in an array or object.

{
  "emailSubject": "a short, specific, non-generic subject line",
  "emailBody": "the full email body as described in PART 1",
  "variants": [
    ${_roleVariantSchemaBlock('Your Next Step', 'one clear level above their current title/scope')}
  ]
}

Return ONLY the JSON object.`;

  // 700-1200+ words of role content plus a full email, as strict escaped
  // JSON, routinely ran past 8000 tokens and got cut off mid-response —
  // jsonrepair can patch the truncated JSON into something parseable, but
  // the actual content inside is incomplete, which surfaced downstream as
  // "came back incomplete." Raised comfortably below both providers' output
  // caps (GPT-4o-mini: 16,384) — and below, a single automatic retry catches
  // the cases where even that isn't enough, rather than making the recruiter
  // manually click regenerate every time the model runs long.
  const MAX_TOKENS = 15000;
  const TRUNCATED_REASON = { openai: 'length', claude: 'max_tokens' };

  function extractVariants(parsed) {
    // The prompt always asks for exactly one variant. When the raw JSON was
    // corrupted deep inside the variant's own content (a broken string a few
    // fields into "Your Next Step"), jsonrepair can recover a structurally
    // valid array that's semantically wrong — the one real variant plus
    // several near-empty stub objects where it guessed a boundary. A variant
    // with no title and no actual role content isn't a second option, it's
    // repair debris, so filter those out rather than attaching blank pages.
    const rawVariants = Array.isArray(parsed.variants) ? parsed.variants : [];
    return rawVariants
      .filter(v => v && typeof v.title === 'string' && v.title.trim() && (
        (Array.isArray(v.responsibilityGroups) && v.responsibilityGroups.some(g => g && Array.isArray(g.bullets) && g.bullets.length)) ||
        (Array.isArray(v.responsibilities) && v.responsibilities.length) // legacy shape
      ))
      .slice(0, 1);
  }

  async function attempt(fullPrompt) {
    const response = await callAI(fullPrompt, MAX_TOKENS, pickProvider(user, instructions));
    const raw = response.content[0].text.trim();
    const truncated = response.finishReason === TRUNCATED_REASON[response.provider];
    let parsed = null, variants = [];
    try {
      parsed = parseAIJson(raw);
      variants = extractVariants(parsed);
    } catch (err) { /* parsed stays null — caller checks for that */ }
    return { raw, parsed, variants, truncated, costCents: calcCostCents(response.usage, response.provider) };
  }

  let result = await attempt(appendInstructions(prompt, instructions));

  // Only worth retrying when the model actually got cut off — a complete
  // response that still failed to parse or came out empty has a different
  // cause a retry with the same prompt won't fix.
  if ((!result.parsed || !result.variants.length) && result.truncated) {
    console.warn('Role JD generation was truncated — retrying once with a concision directive.');
    const concisionNote = `\n\nIMPORTANT: your previous attempt at this was cut off before the JSON finished, which made the whole response unusable. This time, prioritize returning complete, fully-closed JSON over exhaustive detail — use the SHORTER end of every "X-Y" range in the schema (bullet counts, sentence counts), and keep bullets closer to 15-20 words instead of 20-35. A complete, slightly shorter document beats an incomplete long one.`;
    const retryResult = await attempt(appendInstructions(prompt, instructions) + concisionNote);
    retryResult.costCents += result.costCents; // both attempts actually ran, both cost real tokens
    result = retryResult;
  }

  if (!result.parsed) {
    console.error('Role JD JSON parse failed after all repair attempts. Raw response (first 2000 chars):', result.raw.slice(0, 2000));
    throw new Error('Could not parse role JD response as JSON — please try regenerating.');
  }
  if (!result.variants.length) {
    console.error('Role JD parsed but no substantive variant survived validation. Raw (first 2000 chars):', result.raw.slice(0, 2000));
    throw new Error('The AI response came back incomplete — please try regenerating.');
  }

  return {
    subject: result.parsed.emailSubject || '',
    text: result.parsed.emailBody || '',
    variants: result.variants,
    jdLocation,
    costCents: result.costCents
  };
}

async function _generateRecruiterResumeFeedback(candidate, user, instructions) {
  const candidateInfo = formatCandidateContext(candidate);
  const styleInfo = formatUserStyle(user);
  const company = getCompanyContext(user);
  const recruiterTitle = (user.title && user.title.trim()) ? user.title.trim() : 'Senior Talent Acquisition Coordinator';

  if (!candidate.resume || !candidate.resume.text) {
    throw new Error('No resume text available for this candidate');
  }

  const convoContext = formatConversationContext(candidate);

  const prompt = `You are ${user.name}, ${recruiterTitle} at ${company.name}. The candidate sent you their resume and you have now reviewed it. You need to write a detailed, warm, honest email that: responds to what they said when they sent it, praises what IS genuinely strong, identifies specific gaps, explains why it matters, and recommends they work with a professional resume consultant — then asks if they'd like an introduction.
${convoContext ? '\n' + convoContext : ''}
GOLD STANDARD EXAMPLE (follow this structure and tone — but the opening paragraph below assumes the candidate voiced concerns about their own resume; only mirror that premise if the conversation above shows they actually did):
---
Dear Tomeka,

Thank you again for your interest in this opportunity and for being so transparent about your resume concerns. I actually appreciate that honesty quite a bit, because it confirms something I was already sensing while reviewing your background: the depth of your experience is significantly larger than what is currently being communicated on paper. And to be candid with you, that matters at this level.

What we genuinely like about your background at ${company.name} is that your experience is not one-dimensional. Very few candidates have operated across ownership, assisted living operations, home care leadership, elder care advising, member navigation, safety instruction, and patient-facing healthcare systems all within the same career journey. The fact that you personally owned and operated Wright Manor immediately gives your profile operational credibility that cannot be manufactured. That alone changes how leadership teams view your perspective.

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
${recruiterTitle} at ${company.name}
---

CANDIDATE INFORMATION:
${candidateInfo}

RESUME TEXT:
${candidate.resume.text.substring(0, 3000)}

INSTRUCTIONS — follow the gold standard structure, with a responsive opening:
1. "Dear [First Name],"
2. OPENING — respond to what the candidate actually said in their latest message above. Thank them for sending the resume, and address anything specific in their message first: answer questions, acknowledge enthusiasm, timing constraints, or caveats in their own terms. If (and only if) they expressed doubts about their resume, appreciate that honesty and note it confirms what you were already sensing. Never fabricate an admission they didn't make. If there is no conversation context, simply thank them for sending the resume and their interest.
3. Transition into your candid assessment — e.g. "And to be candid with you, how this reads on paper matters at this level."
4. Paragraph: What ${company.name} genuinely LIKES about their background — be specific, name their actual companies/roles, highlight 2-3 genuinely impressive dimensions
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

  const response = await callAI(appendInstructions(prompt, instructions), 2500, pickProvider(user, instructions));

  const text = response.content[0].text.trim();
  const costCents = calcCostCents(response.usage, response.provider);
  try {
    return { ...parseAIJson(text), costCents };
  } catch {
    return { gaps: text, email: '', costCents };
  }
}

async function generateVictoryEmail(candidate, user, instructions) {
  const candidateInfo   = formatCandidateContext(candidate);
  const styleInfo       = formatUserStyle(user);
  const company         = getCompanyContext(user);
  const recruiterTitle  = (user.title && user.title.trim()) ? user.title.trim() : 'Senior Talent Acquisition Coordinator';
  const firstName       = (candidate.name || '').split(' ')[0];

  // Use the recruiter's configured resume consultant partner
  const partnerName  = (user.resumeConsultantName  || '').trim() || 'our resume consultant';
  const partnerEmail = (user.resumeConsultantEmail || '').trim();
  const ccLine       = partnerEmail ? ` (CC: ${partnerEmail})` : '';

  // Recent conversation so the intro responds to what the candidate actually
  // said (their exact words when agreeing, questions, timing constraints)
  // instead of opening with a canned acknowledgement.
  const convoContext = formatConversationContext(candidate);

  const prompt = `You are ${user.name}, ${recruiterTitle}${company.name ? ' at ' + company.name : ''}. The candidate agreed to be introduced to ${partnerName}, a resume consultant you work with. You are writing the introduction email — addressed to the candidate but CC'ing ${partnerName}${ccLine}. This email must feel warm, specific, and urgent — and it must read as a genuine continuation of the conversation below, not a template.
${styleInfo ? '\nSTYLE GUIDANCE:\n' + styleInfo + '\n' : ''}
${convoContext}

GOLD STANDARD EXAMPLE (follow this structure — but note the opening line below is only a fallback; your opening must respond to the candidate's actual last message per the instructions after the example):
---
Dear Tomeka,

Wonderful, I'm glad you're open to the introduction.

I've CC'd ${partnerName} on this email. ${partnerName} is a trusted resume consultant I work with who has helped a number of candidates strengthen their positioning for high-level opportunities similar to this one.

${partnerName}, I wanted to introduce you to Tomeka Wright.

Tomeka brings a genuinely unique and compelling background across senior living ownership, assisted living operations, home care leadership, elder care advisory, health plan navigation, and caregiver safety instruction. She previously owned and operated Wright Manor Assisted Living and has built a career centered around person-centered care, operational leadership, and improving outcomes across the senior care continuum.

After reviewing her resume and background, I believe there is substantially more executive-level operational value present than is currently being communicated on paper. In particular, I believe the strategic positioning, leadership narrative, operational scope, and portfolio-level impact need stronger framing to fully align with the caliber of opportunities she is being considered for.

Tomeka is very thoughtful, mission-driven, and clearly passionate about this work, and I believe with the right presentation strategy her background could become significantly more competitive in executive review environments.

Tomeka, I'll let you and ${partnerName} take it from here regarding timing, process, and next steps.

I do encourage both of you to prioritize this conversation sooner rather than later, as the early stages of review on these opportunities can move quickly once candidate materials begin entering formal consideration.

Looking forward to seeing this come together.

${user.name}
${recruiterTitle}${company.name ? ' at ' + company.name : ''}
---

CANDIDATE INFORMATION:
${candidateInfo}

INSTRUCTIONS — follow the gold standard structure, but make the opening genuinely responsive:
1. "Dear [First Name],"
2. OPENING (1-3 sentences) — respond directly to the candidate's latest message above. Reference what they actually said in their own terms: if they expressed enthusiasm, mirror it; if they asked a question (cost, process, timing), answer it briefly and honestly or say ${partnerName} will cover it; if they mentioned a constraint (travel, timing, hesitation), acknowledge it specifically and work with it. Do NOT use a generic acknowledgement like "Wonderful, I'm glad you're open to the introduction" unless their message truly contained nothing specific to respond to. Their exact words matter — someone reading the opening should be able to tell what the candidate said.
3. "I've CC'd ${partnerName} on this email. ${partnerName} is a trusted resume consultant I work with who has helped a number of candidates strengthen their positioning for high-level opportunities similar to this one."
4. "${partnerName}, I wanted to introduce you to [candidate full name]."
5. Paragraph to ${partnerName} about the candidate: summarize their background genuinely — name their actual companies, roles, and career arc. What makes their profile unique and compelling. If the conversation revealed anything relevant beyond the resume (goals, motivations, context they shared), weave it in.
6. Paragraph about resume gap: "After reviewing her/his resume and background, I believe there is substantially more executive-level operational value present than is currently being communicated on paper. In particular, I believe the strategic positioning, leadership narrative, operational scope, and portfolio-level impact need stronger framing..."
7. Sentence about the candidate's character: "[First Name] is very [specific quality actually shown in the conversation above — how they write, what they asked about, what they care about], and I believe with the right presentation strategy their background could become significantly more competitive in executive review environments."
8. "[First Name], I'll let you and ${partnerName} take it from here regarding timing, process, and next steps." — but if the candidate raised timing or scheduling in their message, adapt this line to reflect what they said.
9. URGENCY: "I do encourage both of you to prioritize this conversation sooner rather than later, as the early stages of review on these opportunities can move quickly once candidate materials begin entering formal consideration." — soften or adapt if it would clash with a constraint the candidate stated (e.g. they said they're away until a date).
10. "Looking forward to seeing this come together."
11. Signature: "${user.name} / ${recruiterTitle}${company.name ? ' at ' + company.name : ''}"

Output ONLY the email body (starting with "Dear ${firstName},"). No subject line, no commentary.

Write the introduction email now:`;

  const response = await callAI(appendInstructions(prompt, instructions), 1000, pickProvider(user, instructions));

  return { text: response.content[0].text.trim(), costCents: calcCostCents(response.usage, response.provider) };
}

// ── Route by userType ─────────────────────────────────────────────────────────
async function generateReply(candidate, user, lastMessage, instructions) {
  const type = user.userType || 'recruiter_company';
  if (type === 'career_consultant') return _generateCareerConsultantReply(candidate, user, lastMessage, instructions);
  return _generateRecruiterReply(candidate, user, lastMessage, instructions);
}

async function generateResumeFeedback(candidate, user, instructions) {
  const type = user.userType || 'recruiter_company';
  if (type === 'career_consultant') return _generateCareerConsultantResumeFeedback(candidate, user, instructions);
  return _generateRecruiterResumeFeedback(candidate, user, instructions);
}

async function generateProposal(candidate, user, instructions) {
  const candidateInfo  = formatCandidateContext(candidate);
  const styleInfo      = formatUserStyle(user);
  const consultantName  = user.name || 'Career Consultant';
  const consultantTitle = (user.title && user.title.trim()) || 'Career Strategist';
  const practiseName    = (user.companyName || '').trim() || '';
  const servicePitch    = (user.companyPitch || '').trim() ||
    'I work with experienced professionals to reposition their career story so it reflects their actual value — better title, better company, better compensation.';
  const firstName = (candidate.name || '').split(' ')[0];
  const convoContext = formatConversationContext(candidate);

  const prompt = `You are ${consultantName}, a career consultant${practiseName ? ' at ' + practiseName : ''}. You have already:
1. Reached out to ${firstName} with a personalised message
2. Sent them your specific observations about their career positioning
3. Reviewed their resume and sent them honest, detailed feedback

${firstName} has responded positively and wants to understand what working together looks like.
${styleInfo ? '\nSTYLE GUIDANCE:\n' + styleInfo + '\n' : ''}
YOUR SERVICE:
${servicePitch}

CANDIDATE INFORMATION:
${candidateInfo}
${convoContext ? '\n' + convoContext : ''}
Write a warm, professional proposal email that covers:

PARAGRAPH 1 — Open by responding to their latest message above: mirror their actual words and energy, answer any question they asked (except pricing — see rules), and acknowledge any constraint they mentioned. Then connect it to something specific from their background or your resume review. If there is no conversation context, acknowledge their interest warmly and specifically instead.

PARAGRAPH 2 — What working together looks like (the process):
- You start by doing a deep audit of their career story — extracting the full scope of what they've actually built
- You rewrite and reposition their resume and LinkedIn to reflect executive-level impact, not just job history
- You make sure the language, framing, and positioning match the calibre of roles they are targeting
- You stay involved through the process — reviewing applications, advising on how to present specific experiences

PARAGRAPH 3 — What they can expect to gain:
- Be specific to THIS candidate's background — what opportunities open up when their story is told properly?
- Reference their actual companies, roles, and what a stronger positioning could unlock for them
- Make it feel concrete and personal, not generic

PARAGRAPH 4 — Low-friction next step (NO call, NO scheduling, by default):
- The next step is simply a reply to this email
- Ask them one clear, easy question — something like: "What roles or level are you targeting right now?" or "What's one thing about your background you feel isn't coming through on paper?"
- This opens the conversation without any commitment
- Do NOT mention a call. Do NOT say "schedule time." Do NOT say "book a session."
- EXCEPTION: if the sender's instructions further below tell you to mention a call or availability, follow those instructions exactly instead of this paragraph's default — they take priority.

RULES:
- Sound warm and confident — not salesy
- Reference their specific background throughout (companies, transitions, what makes them valuable)
- Do NOT include pricing
- Do NOT mention a call, meeting, or scheduling of any kind — unless the sender's instructions further below explicitly say to, in which case follow those instructions exactly
- Do NOT add a signature, sign-off name, title, or company at the end — the sender's email signature is appended automatically
- Under 300 words
- Output ONLY the email body starting with "Dear ${firstName},"

Write the proposal email now:`;

  const response = await callAI(appendInstructions(prompt, instructions), 900, pickProvider(user, instructions));
  return { text: response.content[0].text.trim(), costCents: calcCostCents(response.usage, response.provider) };
}

// ── Career Consultant Reply ───────────────────────────────────────────────────
async function _generateCareerConsultantReply(candidate, user, lastMessage, instructions) {
  const candidateInfo   = formatCandidateContext(candidate);
  const styleInfo       = formatUserStyle(user);
  const consultantName  = user.name || 'Career Consultant';
  const consultantTitle = (user.title && user.title.trim()) || 'Career Strategist';
  const practiseName    = (user.companyName || '').trim() || '';
  const servicePitch    = (user.companyPitch || '').trim() ||
    'I work with experienced professionals to reposition their career story — so their background lands the way it should on paper.';
  const firstName       = (candidate.name || '').split(' ')[0];

  const threadContext = (candidate.thread || []).map(m => ({
    direction: m.direction, subject: m.subject, body: m.body
  }));
  const lastMsg = lastMessage || (threadContext.length > 0 ? threadContext[threadContext.length - 1].body : '');
  const steps   = candidate.stepsCompleted || {};

  // stepsCompleted.roleJD is repurposed as "observationsSent" for career consultants
  const observationsSent = steps.roleJD || false;

  let nextStep;
  if (!observationsSent) {
    nextStep = `NEXT STEP — Deliver your specific observations:
This is the moment you promised in the outreach. You said you had specific thoughts — now deliver them.
Write 2-3 SHORT, punchy bullet points about what you actually see in their background that isn't landing on paper:
- Reference their real companies, transitions, and roles
- Name the gap plainly (e.g. "Your ownership of X is buried" or "Your pivot from A to B reads as a step sideways on paper — it wasn't")
- Keep each bullet to 1 concise sentence
After the observations, land softly: "This is the kind of thing that's worth a proper look. If you want to see what a repositioned version of your story could look like, I'd need to review your current CV/resume. Want to send it over?"
Do NOT pitch your service explicitly yet. Let the observations do the work.`;
  } else if (!steps.resumeRequested) {
    nextStep = `NEXT STEP — Ask for their resume:
They're engaged. Now ask for the resume so you can give them something concrete.
Frame it as: you want to give them actual, useful observations — not generic advice — and for that you need to see their current resume.
"To give you something concrete rather than general, I'd want to look at your actual resume. It doesn't have to be polished — I just need to see how your story is currently framed. Can you send it over?"
Keep this paragraph short and casual. One ask, no pressure.`;
  } else if (steps.resumeRequested && !steps.resumeReceived) {
    nextStep = `NEXT STEP — Gentle follow-up on the resume:
They haven't sent the resume yet. Follow up warmly — acknowledge they're probably busy.
"I know these things get buried — no rush at all. Whenever you have a moment, just attach your current CV/resume and hit reply. Even a draft version is fine."`;
  } else if (steps.resumeReceived && !steps.reviewSent) {
    nextStep = `NEXT STEP — Acknowledge resume receipt and set expectations:
Thank them for sending it. Let them know you're reviewing it carefully and will come back with your honest take.
"Got it — thank you. I'm going to take a proper look and come back to you with my honest assessment. It usually takes me [1-2 days]. I'll flag what I see working and where I think the positioning needs work."`;
  } else {
    nextStep = `NEXT STEP — Keep the conversation warm and moving forward.
Address what they said directly. If they're asking about next steps, point toward the Proposal — what working together would look like.`;
  }

  const prompt = `You are ${consultantName}, a career consultant${practiseName ? ' at ' + practiseName : ''}. You are in a real email conversation with ${candidate.name || 'this professional'}. You are NOT a recruiter. You do NOT represent a company hiring them. You are here to help THEM get to a better position.

YOUR SERVICE:
${servicePitch}
${styleInfo ? '\nSTYLE GUIDANCE:\n' + styleInfo + '\n' : ''}
CANDIDATE INFORMATION:
${candidateInfo}

FULL CONVERSATION (most recent last):
${JSON.stringify(threadContext, null, 2)}

THEIR LAST MESSAGE:
${lastMsg}

${nextStep}

PIPELINE STATUS:
- Outreach sent: ${steps.outreach ? 'Yes' : 'No'}
- Observations delivered: ${observationsSent ? 'Yes' : 'No'}
- Resume requested: ${steps.resumeRequested ? 'Yes' : 'No'}
- Resume received: ${steps.resumeReceived ? 'Yes' : 'No'}
- Feedback sent: ${steps.reviewSent ? 'Yes' : 'No'}

HOW TO HANDLE COMMON RESPONSES:

If they're skeptical or asking "how did you find me":
→ Be direct and honest. "I came across your profile and something about your background stood out — specifically [X from their profile]. That's genuinely why I reached out."

If they say they're happy where they are:
→ "I hear that — and I'm not suggesting there's anything wrong with where you are. What I noticed is that your background is worth more than how it's currently positioned on paper. Whether you move in 6 months or 2 years, having that story properly told costs you nothing except a conversation."

If they ask what you charge:
→ Don't give numbers yet. "Let's figure out if there's actually something useful I can offer first. Once I've seen your resume and given you my honest take, you'll be in a much better position to decide whether it's worth investing in."

If they're very interested and asking what's next:
→ Guide them to send the resume if not done, or reference the feedback you'll be sending.

${voiceGuidance(user)}
CRITICAL RULES:
- ALWAYS address their actual message FIRST before pivoting
- Sound like a real person — specific, warm, direct
- You are their advocate, not trying to hire them
- Reference their actual background (companies, roles) throughout
- Under 250 words
- Do NOT add a signature, sign-off name, title, or company at the end — the sender's email signature is appended automatically
- Output ONLY the email body starting with "Dear ${firstName},"

Write the reply now:`;

  const response = await callAI(appendInstructions(prompt, instructions), 900, pickProvider(user, instructions));
  return { text: response.content[0].text.trim(), costCents: calcCostCents(response.usage, response.provider) };
}

// ── Career Consultant Resume Feedback ────────────────────────────────────────
async function _generateCareerConsultantResumeFeedback(candidate, user, instructions) {
  const candidateInfo   = formatCandidateContext(candidate);
  const styleInfo       = formatUserStyle(user);
  const consultantName  = user.name || 'Career Consultant';
  const consultantTitle = (user.title && user.title.trim()) || 'Career Strategist';
  const practiseName    = (user.companyName || '').trim() || '';
  const servicePitch    = (user.companyPitch || '').trim() ||
    'I work with experienced professionals to reposition their career story so it reflects their actual value.';
  const firstName       = (candidate.name || '').split(' ')[0];

  if (!candidate.resume?.text) throw new Error('No resume text available');

  const convoContext = formatConversationContext(candidate);

  const prompt = `You are ${consultantName}, a career consultant${practiseName ? ' at ' + practiseName : ''}. ${firstName} sent you their resume after expressing interest in your help. You've now reviewed it carefully.

YOUR SERVICE:
${servicePitch}
${styleInfo ? '\nSTYLE GUIDANCE:\n' + styleInfo : ''}
CANDIDATE INFORMATION:
${candidateInfo}
${convoContext ? '\n' + convoContext : ''}
RESUME TEXT:
${candidate.resume.text.substring(0, 3000)}

Write a warm, honest, expert resume assessment email. Structure:

PARAGRAPH 1 — Thank them for sending it, and respond to their latest message above first: if they asked anything, answer it; if they added context or caveats ("it's outdated", "excuse the formatting", timing constraints), acknowledge it in their own terms. Then one genuine observation about what you noticed right away (positive — something that IS working or genuinely impressive in their background).

PARAGRAPH 2 — What's working: 2 specific strengths you see. Reference their actual companies and roles. Be genuine — don't manufacture praise.

PARAGRAPH 3 — The honest assessment: Name the gaps clearly but constructively. Use language like "What I notice is..." or "What isn't coming through yet is...". Be specific — which sections, which roles, which transitions are not landing the way they should. Reference real content from their resume.

PARAGRAPH 4 — Why it matters: Explain what opportunities they're leaving on the table because of the current positioning. Make it feel real and specific to THEIR background — not generic.

PARAGRAPH 5 — What you'd do together: Briefly explain your approach — not a pitch, just 1-3 sentences on how you typically work. Keep it simple and specific.

PARAGRAPH 6 — Low-friction close (NO call, NO scheduling, by default):
- If they're interested, the next step is to simply reply
- Ask them one easy question — something like "What kind of roles are you targeting?" or "Is there a specific part of your background you feel isn't landing?"
- Do NOT mention a call. Do NOT say "schedule time" or "book a session." Just invite a reply.
- EXCEPTION: if the sender's instructions further below tell you to mention a call or availability, follow those instructions exactly instead of this default.

Do NOT add a signature, sign-off name, title, or company at the end of the email — the sender's email signature is appended automatically. End after the final sentence of paragraph 6.

Also return a brief internal analysis. Output as valid JSON:
{
  "gaps": "2-3 sentence internal summary of the specific resume gaps (for your reference)",
  "email": "The full email body"
}

Return ONLY the JSON. No markdown, no extra text.`;

  const response = await callAI(appendInstructions(prompt, instructions), 2000, pickProvider(user, instructions));

  const text = response.content[0].text.trim();
  const costCents = calcCostCents(response.usage, response.provider);
  try {
    return { ...parseAIJson(text), costCents };
  } catch {
    return { gaps: '', email: text, costCents };
  }
}

// ── Recruiter Reply (original, renamed) ──────────────────────────────────────
async function _generateRecruiterReply(candidate, user, lastMessage, instructions) {
  const candidateInfo = formatCandidateContext(candidate);
  const styleInfo     = formatUserStyle(user);
  const company = getCompanyContext(user);
  const recruiterTitle = (user.title && user.title.trim()) ? user.title.trim() : 'Senior Talent Acquisition Coordinator';

  const threadContext = (candidate.thread || []).map(msg => ({
    direction: msg.direction,
    subject: msg.subject,
    body: msg.body
  }));

  const lastMsg = lastMessage || (threadContext.length > 0 ? threadContext[threadContext.length - 1].body : '');
  const stepsCompleted = candidate.stepsCompleted || {};

  // What is the next pipeline step we are working toward?
  let nextStep = '';
  if (!stepsCompleted.roleJD) {
    nextStep = `NEXT PIPELINE STEP: Get the candidate to review the Role JD.
After fully addressing whatever they said, transition toward: "I'd like to ask you to take a look at the role description below. Please take a moment to consider whether this aligns with your vision and where you want to make your next move. If it resonates, just reply and let me know your thoughts — even a one-line reaction helps me understand where you stand. If not, no worries at all." Then add [ROLE DESCRIPTION BELOW] as a placeholder on its own line.
IMPORTANT: Do NOT mention calls, phone conversations, or scheduling by default — keep it email-based. EXCEPTION: if the sender's instructions further below tell you to mention a call or availability, follow those instructions exactly instead — they take priority over this default. Only pivot to the JD if the candidate's message has been properly addressed first.`;
  } else if (!stepsCompleted.resumeRequested) {
    nextStep = `NEXT PIPELINE STEP: Ask for their resume.
After fully addressing whatever they said, transition toward requesting their resume — warmly, with an explanation: "Before we go any further, there are a few details I'd like to review so I can make sure we position you as strongly as possible going into this. Could you send me your current resume when you have a moment?" Then explain WHY: strong candidates get overlooked when their background isn't communicated clearly on paper — you want to make sure theirs lands the way it should. Reference their specific background (companies, roles). End: "Once I've had the chance to review it, I'll come back to you quickly with my thoughts and next steps."
IMPORTANT: Do NOT mention calls, phone conversations, or scheduling by default. EXCEPTION: if the sender's instructions further below tell you to mention a call or availability, follow those instructions exactly instead — they take priority over this default. Only pivot to the resume request if the candidate's message has been properly addressed first.`;
  } else if (stepsCompleted.resumeReceived && !stepsCompleted.reviewSent) {
    nextStep = `NEXT PIPELINE STEP: Acknowledge resume receipt and ask two clarifying questions.
If they just sent their resume or are referencing it, structure your reply as: (1) "I've successfully received your resume, thank you for sending that over." (2) Say you're reviewing against specific requirements. (3) Ask exactly two bullet questions before finalizing feedback: Recency (is this the most current version?) and Comprehensive Scope (does it fully capture their ownership at [company], home care leadership, and other key accomplishments — reference their actual background). (4) "I ask because backgrounds like yours are often much stronger in practice than what initially appears on paper." (5) "Once you confirm those details, I'll finalize my feedback."
IMPORTANT: Only use this structure if the resume is what they're talking about. Otherwise address their actual message first.`;
  } else {
    nextStep = `NEXT PIPELINE STEP: Keep the conversation warm and moving forward naturally based on context. Address whatever they said, then guide gently toward the logical next step.`;
  }

  const prompt = `You are ${user.name}, ${recruiterTitle} at ${company.name}, writing a reply to an executive candidate. This is a real, ongoing conversation. Your reply must do TWO things in order:

1. FIRST — Read and respond directly to what the candidate actually said in their last message
2. THEN — Once their message is addressed, naturally transition to the next pipeline step
${styleInfo ? '\nSTYLE GUIDANCE:\n' + styleInfo + '\n' : ''}
CANDIDATE INFORMATION:
${candidateInfo}

FULL CONVERSATION HISTORY (most recent last):
${JSON.stringify(threadContext, null, 2)}

CANDIDATE'S LAST MESSAGE:
${lastMsg}

PIPELINE STATUS:
- Outreach sent: ${stepsCompleted.outreach ? 'Yes' : 'No'}
- Role JD sent: ${stepsCompleted.roleJD ? 'Yes' : 'No'}
- Resume requested: ${stepsCompleted.resumeRequested ? 'Yes' : 'No'}
- Resume received: ${stepsCompleted.resumeReceived ? 'Yes' : 'No'}
- Resume review sent: ${stepsCompleted.reviewSent ? 'Yes' : 'No'}
- Victory intro sent: ${stepsCompleted.victorySent ? 'Yes' : 'No'}

${nextStep}

HOW TO HANDLE COMMON CANDIDATE RESPONSES — these describe the APPROACH and key points to hit, not a script. Never copy the wording below verbatim; write it fresh, in your own words, reacting to what they specifically said:

If they expressed enthusiasm or said this resonates:
→ Acknowledge it warmly and specifically — quote their exact words, then move to next step with urgency: things are moving quickly on this and you want to keep the momentum going.

If they asked about salary or compensation:
→ Tell them you'll walk them through the full compensation structure once you've reviewed their background properly, and that it's a strong package. Convey that you want to move on this soon.

If they said they're not actively looking:
→ Acknowledge their honesty genuinely. Note that most people you reach out to aren't actively looking either — that's part of why you reached out to them specifically. No pressure to decide today, but be clear the process is moving now and you'd hate for timing to be the only reason they miss it.

If they asked about the team, culture, or what the role looks like day-to-day:
→ Speak to ${company.name}'s mission-driven culture, the collaborative and data-driven environment, and the fact that operational leaders here have genuine influence. Draw on this context: "${company.pitch}" Don't overpromise specifics — offer to share more if they reply, then move to next step.

If they raised a concern about location, travel, or relocation:
→ Acknowledge it directly and specifically. Note ${company.name} has flexible hybrid/remote arrangements and works with candidates on logistics — don't let it become a blocker this early. Then move to next step.

If they asked about the hiring timeline or process:
→ Be honest that this is moving fast — you're actively identifying the right person now, which is exactly why getting their background positioned properly (the next step) matters right now rather than later.

If they said they need to think about it or haven't decided:
→ Give them room, no pressure — but be clear the search is active and moving, and getting the next step done now means they're ready to move if and when they decide it's worth pursuing.

If they pushed back, were skeptical, or asked how you found them:
→ Be honest and warm — name the specific thing in their background that drew you to reach out. You don't reach out to everyone, and you read their background carefully before doing so.

If they proposed a call, asked to talk by phone, or gave you their availability for a call:
→ This is the one case where you SHOULD engage with the call directly — do not deflect or avoid it. Reference their specific availability or request naturally (not a canned line), confirm you want to make that happen, and connect it to the next step — e.g. wanting the resume/JD step done first so the call itself is useful and moves things forward fast, or proposing to lock in time once that's done. Keep the energy of "let's move on this quickly," not "let's slow down and do process first."

${voiceGuidance(user)}
CRITICAL RULES:
- ALWAYS address what they actually said BEFORE pivoting to the next step
- NEVER skip over a question, concern, or hesitation to get to the template
- NEVER open with "Thank you for getting back to me" or any generic filler
- NEVER sound like a script — read their actual message closely and let your reply be shaped by their specific words, tone, and what they emphasized. No two replies should read the same.
- Do not introduce calls, phone conversations, or scheduling yourself by default. But if the candidate raises it first (asks to talk, proposes a call, gives availability), engage with it directly — do not dodge it. Also: if the sender's instructions further below explicitly tell you to mention a call, your availability, or scheduling, that instruction OVERRIDES this default rule — follow it exactly, stating the call plainly, not vaguely.
- Convey real urgency and forward motion throughout — this search is moving fast, you're actively progressing candidates now, and you want to keep things on pace. This should come through naturally in how you frame the next step, not as a bolted-on line about deadlines.
- Reference their actual background (specific companies, roles, words they used) throughout
- Keep it focused — don't try to do too much in one email
- Signature at the end: ${user.name}\n${recruiterTitle} at ${company.name}
- Output ONLY the email body starting with "Dear [First Name]," — no subject line, no extra commentary

Write the reply now:`;

  const response = await callAI(appendInstructions(prompt, instructions), 900, pickProvider(user, instructions));

  return { text: response.content[0].text.trim(), costCents: calcCostCents(response.usage, response.provider) };
}

async function generateFollowUp(candidate, user, instructions, kind = 'outreach', followUpIndex = 0) {
  const candidateInfo = formatCandidateContext(candidate);
  const styleInfo     = formatUserStyle(user);
  const company = getCompanyContext(user);
  const recruiterTitle = (user.title && user.title.trim()) ? user.title.trim() : 'Senior Talent Acquisition Coordinator';
  const firstName = (candidate.name || '').split(' ')[0];
  const steps = candidate.stepsCompleted || {};
  const thread = candidate.thread || [];

  // Last outbound message + days since
  const lastOut = [...thread].reverse().find(m => m.direction === 'outbound');
  const daysSince = lastOut ? Math.floor((Date.now() - new Date(lastOut.timestamp)) / 86400000) : null;
  const daysSinceStr = daysSince != null ? `${daysSince} day${daysSince !== 1 ? 's' : ''} ago` : 'recently';
  const lastOutBody = lastOut ? lastOut.body.substring(0, 600) : '';

  // Has the candidate ever replied?
  const hasReplied = thread.some(m => m.direction === 'inbound');

  // Determine the specific follow-up context
  let scenarioInstructions;

  if (kind === 'roleJD' && followUpIndex === 0) {
    // First touch on the JD — simple, low-pressure resonance check
    scenarioInstructions = `FOLLOW-UP SCENARIO: Role description sent ${daysSinceStr}, first check-in — asking if it resonates.

WHAT TO WRITE (keep it to 2-3 short paragraphs):
1. Open with "Dear ${firstName}," — reference the role description you shared, don't say "just following up."
2. Ask plainly and warmly whether the role resonates with them — where they're at, what stood out (or didn't). Reference one specific thing from their background that makes the fit worth exploring.
3. Low-friction close: even a one-line reaction tells you where they stand.
Signature: ${user.name}\n${recruiterTitle} at ${company.name}`;

  } else if (kind === 'roleJD' && followUpIndex >= 1) {
    // Second touch — real urgency, direct interest check
    scenarioInstructions = `FOLLOW-UP SCENARIO: Second follow-up on the role description ${daysSinceStr} after the first check-in went unanswered — create genuine urgency.

WHAT TO WRITE (keep it to 2-3 short paragraphs):
1. Open with "Dear ${firstName}," — brief, no guilt-tripping about the earlier email.
2. Be direct: the role's availability is closing soon, and you want to know plainly whether they're still interested before that window shuts. Make the urgency feel real and specific to the search's timeline, not manufactured.
3. Ask directly: are they still interested? A quick yes/no is fine.
Signature: ${user.name}\n${recruiterTitle} at ${company.name}`;

  } else if (kind === 'resumeRequested' && followUpIndex === 0) {
    scenarioInstructions = `FOLLOW-UP SCENARIO: Resume requested ${daysSinceStr}, still waiting — first check-in.

WHAT TO WRITE (keep it to 2-3 short paragraphs):
1. Open with "Dear ${firstName}," — warm, non-pressuring. Let them know you're still expecting their resume for review.
2. Make it easy — offer to answer any questions if something's holding them up.
3. Soft close, no hard deadline yet.
Signature: ${user.name}\n${recruiterTitle} at ${company.name}`;

  } else if (kind === 'resumeRequested' && followUpIndex >= 1) {
    scenarioInstructions = `FOLLOW-UP SCENARIO: Resume requested ${daysSinceStr}, second check-in with no resume yet — gauge whether they're still interested.

WHAT TO WRITE (keep it to 2-3 short paragraphs):
1. Open with "Dear ${firstName}," — brief, warm, not accusatory about the silence.
2. Ask directly whether they're still interested in the role — it's fine if timing isn't right, you just want to know so you can plan around it either way.
3. Leave the door open: if they are still interested, the resume is the only thing standing between them and the next step.
Signature: ${user.name}\n${recruiterTitle} at ${company.name}`;

  } else if (steps.resumeRequested && !steps.resumeReceived) {
    // Waiting for resume
    scenarioInstructions = `FOLLOW-UP SCENARIO: Resume requested, not yet received.
You asked ${firstName} for their resume ${daysSinceStr} and haven't received it yet.

WHAT TO WRITE (keep it to 3-4 short paragraphs):
1. Open with "Dear ${firstName}," — a warm, non-pressuring opener that references the resume you asked for. Don't say "just following up" — say something more human.
2. Acknowledge they're likely busy. Make it easy to respond — offer to answer questions if they have concerns about their resume before sending it.
3. Remind them briefly why the resume matters at this stage: early screening, want to position them well.
4. Soft close: "Whenever you have a moment" — no hard deadline, no pressure.
Signature: ${user.name}\n${recruiterTitle} at ${company.name}`;

  } else if (steps.roleJD && !hasReplied) {
    // JD sent, no response at all
    scenarioInstructions = `FOLLOW-UP SCENARIO: Role description was sent, no response yet.
You sent ${firstName} the detailed role description ${daysSinceStr} and they haven't responded.

WHAT TO WRITE (keep it to 3-4 short paragraphs):
1. Open with "Dear ${firstName}," — reference the role description you shared. Don't say "just following up."
2. Acknowledge it's a lot to read and timing isn't always right. Say something like "I didn't want it to get buried."
3. Lower the bar: even a quick "not the right fit" helps you — but you're hoping they'll find it worth a conversation. Reference one specific thing from their background that makes them relevant.
4. Soft CTA: "A quick reply either way tells me where you're at."
Signature: ${user.name}\n${recruiterTitle} at ${company.name}`;

  } else if (steps.outreach && !hasReplied) {
    // Initial outreach, never replied
    scenarioInstructions = `FOLLOW-UP SCENARIO: Initial outreach was sent, no reply yet.
You sent ${firstName} an outreach email ${daysSinceStr} about ${company.name} and they haven't responded.

WHAT TO WRITE (keep it to 3-4 short paragraphs):
1. Open with "Dear ${firstName}," — acknowledge that your first message may have gotten buried or the timing wasn't right. Don't open with an apology or "I wanted to follow up."
2. One sentence re-sparking the curiosity hook — hint there's a specific detail about what ${company.name} is building that you still haven't shared. Don't repeat the full outreach.
3. Lower the bar even further: "Even a one-line reply tells me whether it's worth five minutes of your time."
4. Warmly close — no pressure, no deadline.
Signature: ${user.name}\n${recruiterTitle} at ${company.name}

LAST OUTREACH BODY (for reference — do NOT repeat it, just draw from it):
${lastOutBody}`;

  } else {
    // General follow-up (had some interaction, conversation stalled)
    const lastInbound = [...thread].reverse().find(m => m.direction === 'inbound');
    const lastMsg = lastInbound ? lastInbound.body.substring(0, 400) : '';
    scenarioInstructions = `FOLLOW-UP SCENARIO: Conversation has stalled — checking in warmly.
The last touchpoint with ${firstName} was ${daysSinceStr}. The conversation has gone quiet.

WHAT TO WRITE (keep it to 3 short paragraphs):
1. Open with "Dear ${firstName}," — a brief, warm check-in that references where the conversation left off. Don't use "touching base" or "circling back."
2. Keep things alive without pressure — remind them of one specific reason this opportunity is relevant to their background.
3. Simple CTA: ask if they'd like to continue the conversation.
Signature: ${user.name}\n${recruiterTitle} at ${company.name}

LAST MESSAGE FROM CANDIDATE (for reference):
${lastMsg}`;
  }

  const prompt = `You are ${user.name}, ${recruiterTitle} at ${company.name}, writing a follow-up email to an executive candidate. Follow-up emails must be SHORT (under 150 words in the body), warm, human, and specific to this person's background. Never sound like a template. Never use hollow phrases like "I hope this message finds you well" or "just touching base."
${styleInfo ? '\nSTYLE GUIDANCE:\n' + styleInfo + '\n' : ''}
CANDIDATE INFORMATION:
${candidateInfo}

${scenarioInstructions}
${voiceGuidance(user)}
CRITICAL RULES:
- Keep the entire email body under 150 words
- Sound like a real person — specific, warm, not robotic
- Reference this candidate's actual background (companies, roles) at least once
- Do NOT repeat everything from the outreach — assume they read it
- Convey that this search is active and moving quickly right now — that's part of why a reply sooner rather than later matters. Keep it natural, not a countdown or artificial deadline.
- Output ONLY the email body starting with "Dear ${firstName}," — no subject line, no commentary

Write the follow-up email now:`;

  const response = await callAI(appendInstructions(prompt, instructions), 600, pickProvider(user, instructions));

  return { text: response.content[0].text.trim(), costCents: calcCostCents(response.usage, response.provider) };
}

// ── Review-stage follow-up (draft only — recruiter approves before sending) ───
// Fires when a resume review was sent and the candidate has gone quiet. Asks
// plainly whether they're fixing the resume themselves or want to be
// connected to the recruiter's resume consultant partner.
async function generateReviewFollowUp(candidate, user, instructions) {
  const candidateInfo = formatCandidateContext(candidate);
  const styleInfo      = formatUserStyle(user);
  const company        = getCompanyContext(user);
  const recruiterTitle = (user.title && user.title.trim()) ? user.title.trim() : 'Senior Talent Acquisition Coordinator';
  const firstName      = (candidate.name || '').split(' ')[0];
  const thread         = candidate.thread || [];
  const lastOut = [...thread].reverse().find(m => m.direction === 'outbound');
  const daysSince = lastOut ? Math.floor((Date.now() - new Date(lastOut.timestamp)) / 86400000) : null;
  const daysSinceStr = daysSince != null ? `${daysSince} day${daysSince !== 1 ? 's' : ''} ago` : 'recently';
  const partnerName = (user.resumeConsultantName || '').trim() || 'our resume consultant';

  const prompt = `You are ${user.name}, ${recruiterTitle} at ${company.name}, writing a short check-in to an executive candidate. You sent them honest resume feedback ${daysSinceStr} and haven't heard back since.
${styleInfo ? '\nSTYLE GUIDANCE:\n' + styleInfo + '\n' : ''}
CANDIDATE INFORMATION:
${candidateInfo}

WHAT TO WRITE (keep it to 2-3 short paragraphs):
1. Open with "Dear ${firstName}," — warm, brief check-in referencing the resume feedback you sent, not a generic "just following up."
2. Ask plainly and directly: are they planning to work on the resume themselves, or would they like to be connected with ${partnerName}, the resume consultant you work with, to help strengthen it? Make it a genuine, low-pressure either/or question — not a pitch.
3. Warm, simple close — no pressure either way, just want to know where they stand.

${voiceGuidance(user)}
CRITICAL RULES:
- Keep the entire email body under 130 words
- The core ask is the either/or question about fixing it themselves vs. being connected to ${partnerName} — do not bury it
- Sound like a real person, not a template
- Do NOT add a signature, sign-off name, title, or company at the end — the sender's email signature is appended automatically
- Output ONLY the email body starting with "Dear ${firstName}," — no subject line, no commentary

Write the check-in email now:`;

  const response = await callAI(appendInstructions(prompt, instructions), 500, prefersClaude(user));
  return { text: response.content[0].text.trim(), costCents: calcCostCents(response.usage, response.provider) };
}

// ── Victory-stage follow-up (draft only — recruiter approves before sending) ──
// Fires after the consultant introduction was sent and the candidate has gone
// quiet. Checks in on the consultant conversation and asks for the revised
// resume so it can be included in upcoming application submissions.
async function generateVictoryFollowUp(candidate, user, instructions) {
  const candidateInfo = formatCandidateContext(candidate);
  const styleInfo      = formatUserStyle(user);
  const company        = getCompanyContext(user);
  const recruiterTitle = (user.title && user.title.trim()) ? user.title.trim() : 'Senior Talent Acquisition Coordinator';
  const firstName      = (candidate.name || '').split(' ')[0];
  const partnerName    = (user.resumeConsultantName || '').trim() || 'the resume consultant';

  const prompt = `You are ${user.name}, ${recruiterTitle} at ${company.name}, writing a check-in email to an executive candidate you introduced to ${partnerName}, a resume consultant you work with.
${styleInfo ? '\nSTYLE GUIDANCE:\n' + styleInfo + '\n' : ''}
CANDIDATE INFORMATION:
${candidateInfo}

GOLD STANDARD EXAMPLE (follow this structure and tone closely — adapt names/specifics, keep the substance):
---
Dear ${firstName},

I hope this message finds you well.

I wanted to briefly check in and see how your conversation with ${partnerName}, the resume consultant, has been progressing. I hope the discussion has been helpful as you work on strengthening the executive impact and measurable outcomes within your resume.

I will be submitting several applications for internal review shortly and would be glad to ensure your updated materials are included once they are ready. At your convenience, please feel free to forward the revised version for review.

I appreciate your time and continued interest, and I look forward to reconnecting soon.
---

${voiceGuidance(user)}
CRITICAL RULES:
- Follow the structure and tone of the example closely — this is a proven format, don't rewrite it into something unrecognizable
- Reference their actual background naturally if it fits, but don't force it — this email is deliberately simple and process-focused
- Do NOT add a signature, sign-off name, title, or company at the end — the sender's email signature is appended automatically
- Output ONLY the email body starting with "Dear ${firstName}," — no subject line, no commentary

Write the check-in email now:`;

  const response = await callAI(appendInstructions(prompt, instructions), 500, prefersClaude(user));
  return { text: response.content[0].text.trim(), costCents: calcCostCents(response.usage, response.provider) };
}

async function scoreCandidate(candidate, user) {
  const candidateInfo = formatCandidateContext(candidate);
  const company = getCompanyContext(user);

  const prompt = `You are a senior recruiter at ${company.name}. Score this executive candidate for fit with the company's strategic leadership needs.

Company context: ${company.pitch}

CANDIDATE:
${candidateInfo}

Score them 1-10 on overall executive fit for ${company.name} and return ONLY a valid JSON object:
{
  "score": <integer 1-10>,
  "rationale": "<2-3 specific sentences about this candidate's fit for ${company.name}, referencing their actual background>",
  "strengths": ["<strength 1>", "<strength 2>", "<strength 3>"],
  "concerns": ["<concern 1>", "<concern 2>"]
}

Score 8-10: exceptional fit (deep relevant experience + strategic + executive). 5-7: solid fit with gaps. 1-4: significant gaps.
Return ONLY the JSON.`;

  const response = await callAI(prompt, 400, prefersClaude(user));

  const text = response.content[0].text.trim();
  const costCents = calcCostCents(response.usage, response.provider);
  try {
    return { ...parseAIJson(text), costCents };
  } catch {
    throw new Error('Could not parse score response');
  }
}

// ── Reply sentiment classification (inbox triage) ─────────────────────────────
// Cheap single-call classifier. Returns { label, reason, costCents }.
// label ∈ interested | question | not_now | not_interested
async function classifyReply(candidate, replyText, user) {
  const firstName = (candidate.name || 'the candidate').split(' ')[0];
  const prompt = `Classify the intent of this reply from ${firstName} to a recruiting/career-outreach email. Choose exactly ONE label:

- "interested": positive, wants to learn more, engaged, asks to proceed, shares availability
- "question": neutral — asking a clarifying question before deciding (how did you find me, what's this about, what company)
- "not_now": open but not right now — timing, busy, "reach out later", "not currently looking but maybe"
- "not_interested": clear no — not interested, unsubscribe, stop contacting, wrong person

REPLY:
"""
${(replyText || '').substring(0, 1500)}
"""

Return ONLY valid JSON: {"label":"<one of the four>","reason":"<5-10 word justification>"}`;

  const response = await callAI(prompt, 120, prefersClaude(user));
  const text = response.content[0].text.trim();
  const costCents = calcCostCents(response.usage, response.provider);
  const VALID = ['interested', 'question', 'not_now', 'not_interested'];
  try {
    const parsed = parseAIJson(text);
    if (!VALID.includes(parsed.label)) parsed.label = 'question';
    return { ...parsed, costCents };
  } catch {
    return { label: 'question', reason: 'unparseable', costCents };
  }
}

// ── Resume rewrite / repositioning (career consultant deliverable) ────────────
// Returns { original, rewritten, summary, costCents } for a before/after view.
async function rewriteResume(candidate, user) {
  if (!candidate.resume || !candidate.resume.text) throw new Error('No resume text available');
  const consultantName = user.name || 'Career Consultant';
  const original = candidate.resume.text.substring(0, 6000);

  const prompt = `You are ${consultantName}, an expert resume strategist. Reposition this professional's resume so their actual seniority, scope, and impact land properly on paper — without inventing anything. Keep every real fact; change how it's framed.

ORIGINAL RESUME:
"""
${original}
"""

Produce a repositioned version. Rules:
- Keep it truthful — do not fabricate titles, dates, employers, or metrics
- Strengthen weak bullet points into impact statements (action + scope + outcome)
- Surface buried leadership, ownership, and strategic scope
- Use clean, ATS-friendly plain text with clear section headers (no markdown symbols)
- Open with a sharp professional summary that frames their level correctly

Return ONLY valid JSON:
{
  "summary": "2-3 sentences on the key repositioning moves you made and why",
  "rewritten": "the full repositioned resume as plain text"
}`;

  const response = await callAI(prompt, 4000, prefersClaude(user));
  const text = response.content[0].text.trim();
  const costCents = calcCostCents(response.usage, response.provider);
  try {
    const parsed = parseAIJson(text);
    return { original, rewritten: parsed.rewritten || '', summary: parsed.summary || '', costCents };
  } catch {
    // If JSON parsing fails, treat the whole response as the rewrite
    return { original, rewritten: text, summary: '', costCents };
  }
}

module.exports = {
  generateOutreach,
  generateRoleJD,
  generateResumeFeedback,
  generateVictoryEmail,
  generateReply,
  generateFollowUp,
  generateReviewFollowUp,
  generateVictoryFollowUp,
  generateProposal,
  scoreCandidate,
  classifyReply,
  rewriteResume
};
