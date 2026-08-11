/* ============================================================
   Recruit Pro — Send-Time Scheduling
   Computes the next "good" send time for cold outreach:
   Tue–Thu, 9am, in the recipient's likely timezone.
   No external geocoding — a lightweight location→offset guess,
   falling back to the user's own timezone when unknown.
   ============================================================ */

// Rough UTC offsets (standard time; DST ignored — close enough for a 9am window).
// Keyed by lowercase substrings found in candidate.location / summary.
// Order matters — first match wins, so more-specific / disambiguating entries
// (e.g. "washington dc" as Eastern) come BEFORE the broader ones ("washington"
// state as Pacific). Inferred from candidate.location only, never free-text.
const REGION_OFFSETS = [
  // ── Eastern-specific disambiguators (before Pacific's "washington") ──
  { match: /\b(washington dc|washington, ?dc|d\.?c\.?)\b/, offset: -5 },
  // ── US Pacific (-8) ──
  { match: /\b(california|los angeles|san francisco|san diego|san jose|sacramento|seattle|tacoma|spokane|portland|oregon|nevada|las vegas|reno|ca|wa|or|nv)\b/, offset: -8 },
  // ── US Mountain (-7) ──
  { match: /\b(denver|colorado|boulder|arizona|phoenix|tucson|utah|salt lake|idaho|boise|montana|wyoming|new mexico|albuquerque|mountain time|co|az|ut|nm|id|mt|wy)\b/, offset: -7 },
  // ── US Central (-6) ──
  { match: /\b(chicago|illinois|texas|dallas|houston|austin|san antonio|fort worth|minnesota|minneapolis|missouri|kansas|nebraska|oklahoma|iowa|wisconsin|milwaukee|louisiana|new orleans|arkansas|memphis|nashville|tennessee|central time|tx|il|mn|mo|ks|ne|ok|ia|wi|la|ar|tn)\b/, offset: -6 },
  // ── US Eastern (-5) ──
  { match: /\b(new york|nyc|manhattan|brooklyn|boston|massachusetts|atlanta|georgia|florida|miami|orlando|tampa|jacksonville|philadelphia|pittsburgh|pennsylvania|virginia|richmond|maryland|baltimore|ohio|columbus|cleveland|cincinnati|michigan|detroit|indiana|indianapolis|kentucky|north carolina|charlotte|raleigh|south carolina|connecticut|new jersey|newark|maine|vermont|new hampshire|rhode island|delaware|west virginia|eastern time|ny|ma|fl|ga|nc|sc|va|md|nj|pa|oh|mi|in|ky|ct|me|vt|nh|ri|de|wv)\b/, offset: -5 },
  { match: /\b(united states|usa|u\.s\.a?\.?|remote us|remote, us)\b/, offset: -5 }, // US, region unknown → Eastern default

  // ── Canada ──
  { match: /\b(vancouver|british columbia|victoria bc)\b/, offset: -8 },
  { match: /\b(calgary|edmonton|alberta)\b/, offset: -7 },
  { match: /\b(winnipeg|manitoba|saskatchewan|regina|saskatoon)\b/, offset: -6 },
  { match: /\b(toronto|ottawa|montreal|quebec|ontario|halifax|canada)\b/, offset: -5 },

  // ── Latin America ──
  { match: /\b(mexico|mexico city|guadalajara|monterrey)\b/, offset: -6 },
  { match: /\b(colombia|bogota|peru|lima|ecuador|quito)\b/, offset: -5 },
  { match: /\b(brazil|brasil|sao paulo|são paulo|rio de janeiro|argentina|buenos aires|chile|santiago|uruguay|montevideo)\b/, offset: -3 },

  // ── Europe / UK / Africa ──
  { match: /\b(london|uk|united kingdom|england|scotland|edinburgh|glasgow|wales|ireland|dublin|lisbon|portugal|iceland|reykjavik|gmt|bst)\b/, offset: 0 },
  { match: /\b(paris|france|berlin|munich|frankfurt|germany|madrid|barcelona|spain|rome|milan|italy|amsterdam|rotterdam|netherlands|brussels|belgium|zurich|geneva|switzerland|vienna|austria|stockholm|sweden|oslo|norway|copenhagen|denmark|warsaw|poland|prague|czech|budapest|hungary|europe|cet|lagos|nigeria|johannesburg|cape town|south africa)\b/, offset: 1 },
  { match: /\b(athens|greece|helsinki|finland|bucharest|romania|kyiv|kiev|ukraine|istanbul|turkey|cairo|egypt|israel|tel aviv|jerusalem|nairobi|kenya)\b/, offset: 2 },
  { match: /\b(moscow|russia|riyadh|saudi|kuwait|qatar|doha|bahrain|baghdad|iraq)\b/, offset: 3 },
  { match: /\b(dubai|uae|abu dhabi|united arab emirates|muscat|oman|azerbaijan|baku|georgia tbilisi|armenia)\b/, offset: 4 },
  { match: /\b(pakistan|karachi|lahore|islamabad|uzbekistan|tashkent|kazakhstan)\b/, offset: 5 },

  // ── South & SE Asia ──
  { match: /\b(india|mumbai|delhi|new delhi|bangalore|bengaluru|hyderabad|pune|chennai|kolkata|gurgaon|gurugram|noida|sri lanka|colombo)\b/, offset: 5.5 },
  { match: /\b(bangladesh|dhaka)\b/, offset: 6 },
  { match: /\b(thailand|bangkok|vietnam|hanoi|ho chi minh|jakarta|indonesia)\b/, offset: 7 },
  { match: /\b(singapore|hong kong|beijing|shanghai|shenzhen|guangzhou|china|malaysia|kuala lumpur|manila|philippines|taiwan|taipei|perth)\b/, offset: 8 },
  { match: /\b(tokyo|osaka|japan|seoul|korea|south korea)\b/, offset: 9 },

  // ── Oceania ──
  { match: /\b(sydney|melbourne|canberra|australia|brisbane|adelaide)\b/, offset: 10 },
  { match: /\b(auckland|wellington|new zealand)\b/, offset: 12 },
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
 *
 * nextSendTime snaps to exactly 9:00 AM, so every follow-up scheduled the same
 * day would otherwise fire at the identical instant — a whole day's worth
 * (e.g. all the follow-ups for one big outreach batch) becoming due at once and
 * going out as a back-to-back burst. Spreading each across the following ~4
 * hours (9 AM–1 PM local, all still business hours) de-clusters them into a
 * natural drip instead of a bulk blast.
 */
const FOLLOWUP_SPREAD_MS = 4 * 60 * 60 * 1000; // 4 hours

function followUpTime({ locationText = '', fallbackOffset = DEFAULT_OFFSET, days = 3, from = new Date() } = {}) {
  const base = new Date(from.getTime() + days * 24 * 3600 * 1000);
  const nineAm = nextSendTime({ locationText, fallbackOffset, from: base });
  const jittered = new Date(nineAm).getTime() + Math.floor(Math.random() * FOLLOWUP_SPREAD_MS);
  return new Date(jittered).toISOString();
}

// The user's own UTC offset (hours). Prefer the real timezone captured from
// their browser; fall back to guessing from location text, then ET.
function userOffset(user) {
  if (user && typeof user.tzOffset === 'number' && user.tzOffset >= -12 && user.tzOffset <= 14) {
    return user.tzOffset;
  }
  const guess = guessOffset((user && (user.location || user.companyName)) || '');
  return guess === null ? DEFAULT_OFFSET : guess;
}

module.exports = { nextSendTime, followUpTime, guessOffset, userOffset, DEFAULT_OFFSET };
