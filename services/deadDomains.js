/* ============================================================
   Known-defunct email domains — catches a certain-bounce BEFORE
   the first send, not after. Zero cost (no Apify call needed),
   and feeds the same emailStatus/skipUndeliverable machinery
   that already governs undeliverable handling everywhere else.

   Deliberately short and conservative: every domain here is one
   this app has actually seen hard-bounce, or a provider that is
   unambiguously, permanently gone (not just "old" or "declining
   in popularity") — a false positive here silently drops a real
   candidate's contact, which is worse than missing one dead
   address. When in doubt, a domain is left OUT of this list and
   handled by the normal verify/bounce-detection flow instead.
   ============================================================ */

// domain -> short reason (kept for logs / a future "why flagged" tooltip)
const DEAD_DOMAINS = new Map([
  ['adelphia.net',  'Adelphia Communications dissolved in 2006 — no mail service has run on this domain since'],
  ['angelfire.com', 'Lycos-owned free website host, never a real mail provider — addresses here do not receive mail'],
  ['rr.com',        'Time Warner Cable "Roadrunner" — fully migrated to spectrum.net; this domain no longer delivers'],
]);

function domainOf(email) {
  const at = (email || '').lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1).trim().toLowerCase();
}

// Returns the reason string if the email's domain is known-defunct, else null.
function deadDomainReason(email) {
  const domain = domainOf(email);
  if (!domain) return null;
  if (DEAD_DOMAINS.has(domain)) return DEAD_DOMAINS.get(domain);
  // Match subdomains of a listed domain too (e.g. mail.rr.com)
  for (const [d, reason] of DEAD_DOMAINS) {
    if (domain.endsWith('.' + d)) return reason;
  }
  return null;
}

module.exports = { deadDomainReason };
