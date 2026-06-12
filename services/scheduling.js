/* ============================================================
   Recruit Pro — Send-Time Scheduling
   Computes the next "good" send time for cold outreach:
   Tue–Thu, 9am, in the recipient's likely timezone.
   No external geocoding — a lightweight location→offset guess,
   falling back to the user's own timezone when unknown.
   ============================================================ */

// Rough UTC offsets (standard time; DST ignored — close enough for a 9am window).
// Keyed by lowercase substrings found in candidate.location / summary.
const REGION_OFFSETS = [
  // US time zones by state hints
  { match: /\b(california|los angeles|san francisco|seattle|portland|oregon|washington|nevada|las vegas|ca|wa|or)\b/, offset: -8 },
  { match: /\b(denver|colorado|arizona|phoenix|utah|salt lake|mountain|co|az|ut|nm|new mexico)\b/,                    offset: -7 },
  { match: /\b(chicago|texas|dallas|houston|austin|illinois|minnesota|missouri|wisconsin|central|tx|il|mn|mo|wi)\b/,  offset: -6 },
  { match: /\b(new york|nyc|boston|atlanta|florida|miami|washington dc|philadelphia|virginia|georgia|ny|ma|fl|ga|nc|va|nj|pa|eastern)\b/, offset: -5 },
  // International
  { match: /\b(london|uk|united kingdom|england|ireland|dublin|lisbon|portugal)\b/, offset: 0 },
  { match: /\b(paris|berlin|madrid|rome|amsterdam|france|germany|spain|italy|netherlands|europe|cet)\b/, offset: 1 },
  { match: /\b(dubai|uae|abu dhabi)\b/, offset: 4 },
  { match: /\b(india|mumbai|delhi|bangalore|bengaluru|hyderabad|pune|chennai)\b/, offset: 5.5 },
  { match: /\b(singapore|hong kong|beijing|shanghai|china|malaysia|kuala lumpur)\b/, offset: 8 },
  { match: /\b(tokyo|japan|seoul|korea)\b/, offset: 9 },
  { match: /\b(sydney|melbourne|australia|brisbane)\b/, offset: 10 },
  // Canada
  { match: /\b(toronto|ottawa|montreal|canada)\b/, offset: -5 },
  { match: /\b(vancouver)\b/, offset: -8 },
];

const DEFAULT_OFFSET = -5; // US Eastern — most common for this product

// Guess a UTC offset (in hours) from free-text location/summary. Returns null if unknown.
function guessOffset(text) {
  if (!text) return null;
  const lower = String(text).toLowerCase();
  for (const r of REGION_OFFSETS) {
    if (r.match.test(lower)) return r.offset;
  }
  return null;
}

/**
 * Compute the next send time: the upcoming Tue/Wed/Thu at 9:00am in the
 * recipient's timezone, expressed as an ISO string in UTC.
 * @param {object} opts
 * @param {string} opts.locationText  free text to infer timezone from
 * @param {number} opts.fallbackOffset UTC offset to use when location unknown (user's tz)
 * @param {Date}   opts.from           base time (defaults to now)
 */
function nextSendTime({ locationText = '', fallbackOffset = DEFAULT_OFFSET, from = new Date() } = {}) {
  const offset = guessOffset(locationText);
  const tzOffset = (offset === null) ? fallbackOffset : offset;

  // Current time in the recipient's local clock
  const localNow = new Date(from.getTime() + tzOffset * 3600 * 1000);

  // Walk forward to the next Tue(2)/Wed(3)/Thu(4) at 9am local
  const candidate = new Date(localNow);
  candidate.setUTCHours(9, 0, 0, 0); // 9am local (we're working in shifted UTC)

  for (let i = 0; i < 8; i++) {
    const day = candidate.getUTCDay();
    const isGoodDay = day >= 2 && day <= 4; // Tue–Thu
    if (isGoodDay && candidate.getTime() > localNow.getTime()) {
      // Convert local-clock time back to real UTC
      return new Date(candidate.getTime() - tzOffset * 3600 * 1000).toISOString();
    }
    candidate.setUTCDate(candidate.getUTCDate() + 1);
    candidate.setUTCHours(9, 0, 0, 0);
  }
  // Fallback (shouldn't hit): just send in an hour
  return new Date(from.getTime() + 3600 * 1000).toISOString();
}

/**
 * Add N business-ish days to a base date for follow-up spacing, landing on a
 * Tue–Thu 9am window in the recipient's timezone.
 */
function followUpTime({ locationText = '', fallbackOffset = DEFAULT_OFFSET, days = 3, from = new Date() } = {}) {
  const base = new Date(from.getTime() + days * 24 * 3600 * 1000);
  return nextSendTime({ locationText, fallbackOffset, from: base });
}

// Infer the user's own offset from their company/location settings, default ET.
function userOffset(user) {
  const guess = guessOffset((user && (user.location || user.companyName)) || '');
  return guess === null ? DEFAULT_OFFSET : guess;
}

module.exports = { nextSendTime, followUpTime, guessOffset, userOffset, DEFAULT_OFFSET };
