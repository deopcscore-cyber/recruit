/* ============================================================
   Recruit Pro — LinkedIn Profile Importer + Email Enrichment
   ============================================================
   Email enrichment waterfall (personal email first):
     1. ContactOut  → personal email + phone  (best for personal)
     2. Apollo.io   → personal + work email   (largest database)
     3. Hunter.io   → work email              (good for work)
   ============================================================ */

const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PARSE_PROMPT = (text, url) => `Parse the following LinkedIn profile text and extract structured information.

LINKEDIN PROFILE TEXT:
${text.substring(0, 5000)}

${url ? `PROFILE URL: ${url}` : ''}

Extract and return ONLY this exact JSON (no other text, no markdown):
{
  "name": "Full Name",
  "title": "Current job title",
  "company": "Current company name",
  "location": "City, State/Country",
  "summary": "About section or headline summary (2-4 sentences max)",
  "career": [
    { "title": "Job Title", "company": "Company Name", "dates": "Jan 2020 – Present", "description": "Brief description of role" }
  ],
  "education": [
    { "degree": "Degree / Program", "school": "School Name", "year": "Year or date range" }
  ]
}

Rules:
- career: list all positions found, most recent first
- If a field is missing, use "" for strings and [] for arrays
- Return ONLY the JSON object, nothing else`;

// ── URL scraper (usually blocked by LinkedIn) ─────────────────────────────
async function scrapeFromUrl(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache'
      },
      redirect: 'follow'
    });

    if (!res.ok) return null;
    const html = await res.text();
    if (html.includes('authwall') || (html.includes('login') && html.includes('session_redirect'))) return null;

    const jsonLdMatches = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)];
    for (const match of jsonLdMatches) {
      try {
        const data = JSON.parse(match[1]);
        if (data['@type'] === 'Person' && data.name) {
          return {
            name: data.name || '',
            title: data.jobTitle || '',
            company: data.worksFor ? (Array.isArray(data.worksFor) ? data.worksFor[0]?.name : data.worksFor.name) || '' : '',
            location: data.address?.addressLocality || '',
            summary: data.description || '',
            career: [], education: []
          };
        }
      } catch (_) {}
    }

    const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
    const descMatch  = html.match(/<meta property="og:description" content="([^"]+)"/);
    if (titleMatch) {
      const parts = titleMatch[1].replace(' | LinkedIn', '').split(' - ');
      return {
        name: parts[0]?.trim() || '',
        title: parts[1]?.split(' at ')[0]?.trim() || '',
        company: parts[1]?.split(' at ')[1]?.trim() || '',
        location: '', summary: descMatch ? descMatch[1] : '',
        career: [], education: []
      };
    }
    return null;
  } catch (err) {
    console.warn('LinkedIn URL fetch failed:', err.message);
    return null;
  }
}

// ── Claude AI text parser ─────────────────────────────────────────────────
async function parseFromText(rawText, url = '') {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: PARSE_PROMPT(rawText, url) }]
  });

  const text = response.content[0].text.trim();
  try {
    const clean = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(clean);
  } catch (_) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return { name: '', title: '', company: '', location: '', summary: '', career: [], education: [] };
  }
}

// ── ContactOut — best for personal emails + phone numbers ────────────────
// Docs: https://contactout.com/api
async function findViaContactOut(linkedinUrl, apiKey) {
  if (!apiKey || !linkedinUrl) return { email: '', phone: '', source: '' };
  try {
    // Pass the key in the `token` header, not the query string, so it never
    // lands in proxy/access logs.
    const res = await fetch(
      `https://api.contactout.com/v1/people/email?linkedin=${encodeURIComponent(linkedinUrl)}`,
      { headers: { 'Accept': 'application/json', 'token': apiKey } }
    );
    if (!res.ok) return { email: '', phone: '', source: '' };
    const data = await res.json();

    const profile = data.profile || data;
    const emails  = profile.emails  || [];
    const phones  = profile.phones  || [];

    // Prefer personal emails (gmail, yahoo, hotmail, outlook personal, icloud, me.com)
    const PERSONAL_DOMAINS = /@(gmail|yahoo|hotmail|outlook|icloud|me|live|aol|protonmail|pm)\./i;
    const personalEmail = emails.find(e => PERSONAL_DOMAINS.test(e.value || e))?.value
                       || emails.find(e => (e.type || '').toLowerCase() === 'personal')?.value
                       || '';
    const anyEmail = emails[0]?.value || emails[0] || '';
    const phone    = phones[0]?.value || phones[0] || '';

    return {
      email:  personalEmail || anyEmail,
      phone,
      source: (personalEmail || anyEmail) ? 'ContactOut' : ''
    };
  } catch (err) {
    console.warn('ContactOut error:', err.message);
    return { email: '', phone: '', source: '' };
  }
}

// ── Apollo.io — huge database, personal + work emails ────────────────────
// Docs: https://apolloio.github.io/apollo-api-docs
async function findViaApollo(name, company, linkedinUrl, apiKey) {
  if (!apiKey) return { email: '', personalEmail: '', workEmail: '', phone: '', source: '' };
  try {
    const nameParts  = (name || '').trim().split(/\s+/);
    const firstName  = nameParts[0] || '';
    const lastName   = nameParts.slice(1).join(' ') || '';

    const body = {
      api_key:           apiKey,
      first_name:        firstName,
      last_name:         lastName,
      organization_name: company || '',
      ...(linkedinUrl ? { linkedin_url: linkedinUrl } : {})
    };

    const res = await fetch('https://api.apollo.io/v1/people/match', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Cache-Control': 'no-cache' },
      body:    JSON.stringify(body)
    });

    if (!res.ok) return { email: '', personalEmail: '', workEmail: '', phone: '', source: '' };
    const data   = await res.json();
    const person = data.person || {};

    const personalEmails = (person.personal_emails || []).filter(Boolean);
    const workEmail      = person.email || '';
    const phones         = (person.phone_numbers || [])
                            .map(p => p.sanitized_number || p.raw_number)
                            .filter(Boolean);

    const bestEmail = personalEmails[0] || workEmail || '';
    return {
      email:        bestEmail,
      personalEmail: personalEmails[0] || '',
      workEmail,
      phone:        phones[0] || '',
      source:       bestEmail ? 'Apollo' : ''
    };
  } catch (err) {
    console.warn('Apollo error:', err.message);
    return { email: '', personalEmail: '', workEmail: '', phone: '', source: '' };
  }
}

// ── Hunter.io — reliable for work emails ─────────────────────────────────
async function findEmailViaHunter(name, company, apiKey) {
  if (!apiKey || !name || !company) return '';
  try {
    const nameParts = name.trim().split(/\s+/);
    const firstName = nameParts[0];
    const lastName  = nameParts.slice(1).join(' ');
    const domain    = company.toLowerCase()
      .replace(/\b(inc|llc|ltd|corp|company|co|group|the)\b/gi, '')
      .replace(/[^a-z0-9]/g, '').substring(0, 30) + '.com';

    const res = await fetch(
      `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(lastName)}&api_key=${apiKey}`
    );
    if (!res.ok) return '';
    const data = await res.json();
    return (data.data && data.data.email) ? data.data.email : '';
  } catch (_) { return ''; }
}

// ── Main enrichment waterfall ─────────────────────────────────────────────
// Tries all configured providers and returns the best result.
// Always returns { email, personalEmail, workEmail, phone, source }
async function enrichContact({ name, company, linkedinUrl, hunterApiKey, contactOutApiKey, apolloApiKey }) {
  let personalEmail = '', workEmail = '', phone = '', source = '';

  // 1. ContactOut — best personal email coverage
  if (contactOutApiKey && linkedinUrl) {
    const co = await findViaContactOut(linkedinUrl, contactOutApiKey);
    if (co.email) { personalEmail = co.email; phone = co.phone; source = co.source; }
  }

  // 2. Apollo — large database, fills gaps
  if (apolloApiKey && (!personalEmail || !phone)) {
    const ap = await findViaApollo(name, company, linkedinUrl, apolloApiKey);
    if (!personalEmail && ap.personalEmail) { personalEmail = ap.personalEmail; source = ap.source; }
    if (!workEmail    && ap.workEmail)      { workEmail     = ap.workEmail; }
    if (!phone        && ap.phone)          { phone         = ap.phone; }
    if (!personalEmail && ap.email)         { personalEmail = ap.email; source = ap.source; }
  }

  // 3. Hunter.io — reliable for work emails
  if (hunterApiKey && !workEmail && name && company) {
    const h = await findEmailViaHunter(name, company, hunterApiKey);
    if (h) { workEmail = h; if (!source) source = 'Hunter.io'; }
  }

  return {
    email:         personalEmail || workEmail || '',
    personalEmail: personalEmail || '',
    workEmail:     workEmail || '',
    phone:         phone || '',
    source
  };
}

module.exports = { scrapeFromUrl, parseFromText, findEmailViaHunter, findViaContactOut, findViaApollo, enrichContact };
