/* ============================================================
   Apify — email deliverability verification
   Uses the amr-mando/email-verifier actor. Picked after live-testing
   it against a known-good address and two known-bad ones (a fake
   mailbox at a real domain, and a nonexistent domain) — it correctly
   classified all three via a real SMTP-level check, at roughly a
   tenth of Hunter.io's per-verification cost.
   ============================================================ */

const ACTOR_ID = 'amr-mando~email-verifier';
// Keeps each run comfortably under Apify's 300s sync-call timeout —
// the actor does a live SMTP handshake per address, so a big batch in
// one call risks the whole run timing out and losing every result.
const BATCH_SIZE = 50;

// Verifies a batch of emails in as few Apify actor runs as possible.
// Returns a Map of lowercased email -> the actor's result string
// ('deliverable' | 'undeliverable' | possibly 'risky' for catch-all
// domains). An email missing from the map means it wasn't checked
// (no key, empty input, or that chunk's run failed) — callers should
// treat absence as "not checked," not as any particular status.
async function verifyEmailsBatch(emails, apiKey) {
  const results = new Map();
  if (!apiKey || !emails || !emails.length) return results;

  const unique = [...new Set(emails.filter(Boolean).map(e => e.toLowerCase()))];

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const chunk = unique.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(
        `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emails: chunk })
        }
      );
      if (!res.ok) continue;
      const items = await res.json();
      if (!Array.isArray(items)) continue;
      items.forEach(item => {
        if (item && item.email && item.result) {
          results.set(item.email.toLowerCase(), item.result);
        }
      });
    } catch (err) {
      console.warn('Apify email verification error:', err.message);
    }
  }

  return results;
}

module.exports = { verifyEmailsBatch };
