'use strict';

const { rateLimit, MemoryStore } = require('express-rate-limit');

// Per-IP rate limit: protects the endpoint from a single abusive client.
// express-rate-limit sets Retry-After and the standard RateLimit-* headers.
//
// A dedicated MemoryStore is created here (rather than letting the library
// default one in implicitly) so tests can reset all counters between test
// cases with __reset(), instead of every test in a file sharing one
// process-lifetime bucket keyed by the same loopback IP.
function createPerIpLimiter() {
  const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
  const max = Number(process.env.RATE_LIMIT_PER_WINDOW || 10);
  const store = new MemoryStore();
  const middleware = rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store,
    message: { error: 'Too many requests. Please wait before asking again.' }
  });
  middleware.__reset = () => store.resetAll();
  return middleware;
}

// A simple rolling-window token bucket shared across all clients, because
// the endpoint spends money per call regardless of who is calling.
function createDailyCap(options = {}) {
  const windowMs = options.windowMs ?? Number(process.env.DAILY_CAP_WINDOW_MS || 24 * 60 * 60 * 1000);
  const max = options.max ?? Number(process.env.DAILY_CALL_CAP || 500);

  let windowStart = Date.now();
  let count = 0;

  function middleware(req, res, next) {
    const now = Date.now();
    if (now - windowStart >= windowMs) {
      windowStart = now;
      count = 0;
    }
    if (count >= max) {
      const retryAfterSeconds = Math.ceil((windowStart + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error: 'Daily call cap reached. Please try again later.' });
    }
    count++;
    next();
  }

  middleware.__reset = () => {
    windowStart = Date.now();
    count = 0;
  };
  middleware.__getCount = () => count;

  return middleware;
}

module.exports = { createPerIpLimiter, createDailyCap };
