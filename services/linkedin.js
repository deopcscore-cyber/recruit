/* ============================================================
   Recruit Pro — LinkedIn Profile Importer + Email Enrichment
   ============================================================
   Email enrichment waterfall (personal email first):
     1. ContactOut  → personal email + phone  (best for personal)
     2. Apollo.io   → personal + work email   (largest database)
     3. Hunter.io   → work email              (good for work)
   ============================================================ */

const claudeSvc = require('./claude');

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

// ── Copy-paste text cleanup ─────────────────────────────────────────────────
// A pasted LinkedIn page is mostly noise: the person's activity feed
// (reposts, reaction/comment counts, "Like Comment Repost" boilerplate) sits
// physically BETWEEN the profile header and the real Experience/Education
// sections, often dwarfing them — on a moderately active profile it can be
// 10x the length of the actual profile data. That's the real reason AI
// parsing did badly here: not a model problem, an input problem. This never
// touches the Chrome extension's DOM-based path (services/linkedin.js's
// parseFromText, called from routes/linkedin.js's /quick-import only when
// DOM extraction failed) — only the copy-paste flows (bookmarklet, manual
// paste) where there's no DOM to query and cleanup has to work on plain text.
function cleanLinkedInPasteText(raw) {
  // Strip markdown-style links: [label](url) -> label — the popup/bookmarklet
  // relay sometimes hands back the page as markdown-ish link syntax.
  let text = (raw || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  let lines = text.split('\n').map(l => l.trim());

  // The feed/activity block always sits between the header and "Experience"
  // — cut it out entirely rather than let AI wade through it.
  const activityIdx   = lines.findIndex(l => l === 'Activity');
  const experienceIdx = lines.findIndex(l => l === 'Experience');
  if (activityIdx !== -1 && experienceIdx !== -1 && experienceIdx > activityIdx) {
    lines = [...lines.slice(0, activityIdx), ...lines.slice(experienceIdx)];
  }

  // Testimonials and suggested-people sections after Education/Skills are
  // also never profile data — drop from the first one found onward.
  const TAIL_MARKERS = ['Recommendations', 'Interests', 'People you may know', 'More profiles for you', 'You might like', 'Explore Premium profiles'];
  for (const marker of TAIL_MARKERS) {
    const idx = lines.indexOf(marker);
    if (idx !== -1) { lines = lines.slice(0, idx); break; }
  }

  // Drop known UI boilerplate lines wherever they still occur.
  const NOISE_LINE = /^(Like|Comment|Repost|Send|Follow|Connect|Message|Show all.*|About|Posts|Comments|·|·\s*\d\w*\+?|\d+\s*(reactions?|reposts?|comments?)\d*|followers?|connections?|View job|\d+\s*notifications?|500\+)$/i;

  return lines
    .filter(l => l && !NOISE_LINE.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── AI text parser ─────────────────────────────────────────────────────────
// Delegates to services/claude.js so this goes through the same
// primary-provider/Claude-fallback routing as every other AI feature in the
// app, instead of depending solely on the Anthropic account having credits.
// Cleans the pasted text first (see above) so the model gets the actual
// profile instead of a feed dump with the profile buried inside it.
async function parseFromText(rawText, url = '', user = null) {
  return claudeSvc.parseLinkedInProfile(cleanLinkedInPasteText(rawText), url, user);
}

// LinkedIn's headline is free text but very often follows "Title at Company"
// or "Title @ Company" — split it deterministically when it does, so the
// extension's DOM-extracted headline (see extension/content.js) doesn't need
// an AI call just to separate two fields that are usually already delimited.
function splitHeadline(headline) {
  const h = (headline || '').trim();
  const m = h.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
  if (m) return { title: m[1].trim(), company: m[2].trim() };
  return { title: h, company: '' };
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

module.exports = { scrapeFromUrl, parseFromText, splitHeadline, cleanLinkedInPasteText, findEmailViaHunter, findViaContactOut, findViaApollo, enrichContact };
