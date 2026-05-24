/* ============================================================
   Recruit Pro — LinkedIn Profile Importer
   Strategy:
   1. Attempt to fetch the public profile URL (often blocked by LinkedIn)
   2. If blocked, fall back to Claude parsing of pasted profile text
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

    // LinkedIn redirects to login page if not logged in — detect this
    if (html.includes('authwall') || html.includes('login') && html.includes('session_redirect')) {
      return null; // Blocked
    }

    // Try JSON-LD structured data first
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
            career: [],
            education: []
          };
        }
      } catch (_) {}
    }

    // Try og:title as minimal fallback
    const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
    const descMatch  = html.match(/<meta property="og:description" content="([^"]+)"/);
    if (titleMatch) {
      // og:title format: "Name - Title at Company | LinkedIn"
      const ogTitle = titleMatch[1];
      const parts = ogTitle.replace(' | LinkedIn', '').split(' - ');
      return {
        name: parts[0]?.trim() || '',
        title: parts[1]?.split(' at ')[0]?.trim() || '',
        company: parts[1]?.split(' at ')[1]?.trim() || '',
        location: '',
        summary: descMatch ? descMatch[1] : '',
        career: [],
        education: []
      };
    }

    return null;
  } catch (err) {
    console.warn('LinkedIn URL fetch failed:', err.message);
    return null;
  }
}

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

async function findEmailViaHunter(name, company, apiKey) {
  if (!apiKey || !name || !company) return '';
  try {
    const nameParts = name.trim().split(/\s+/);
    const firstName = nameParts[0];
    const lastName  = nameParts.slice(1).join(' ');
    // Guess domain from company name (rough heuristic — Hunter may correct it)
    const domain = company.toLowerCase()
      .replace(/\b(inc|llc|ltd|corp|company|co|group|the)\b/gi, '')
      .replace(/[^a-z0-9]/g, '').substring(0, 30) + '.com';

    const res = await fetch(
      `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(lastName)}&api_key=${apiKey}`
    );
    if (!res.ok) return '';
    const data = await res.json();
    return (data.data && data.data.email) ? data.data.email : '';
  } catch (_) {
    return '';
  }
}

module.exports = { scrapeFromUrl, parseFromText, findEmailViaHunter };
