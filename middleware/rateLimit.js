/* Tiny in-memory fixed-window rate limiter — no external deps.
   Suitable for a single-process deployment (Railway runs one instance). */

function rateLimit({ windowMs = 60 * 1000, max = 60, message = 'Too many requests, please try again later.' } = {}) {
  const hits = new Map(); // key → { count, resetAt }

  // Periodic cleanup so the map doesn't grow unbounded
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs);
  sweep.unref();

  return function (req, res, next) {
    const key = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

module.exports = rateLimit;
