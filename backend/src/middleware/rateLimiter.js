const rateLimit = require('express-rate-limit');

/**
 * Creates an in-memory route rate limiter using express-rate-limit.
 *
 * Multi-Instance Limitation:
 * This implementation relies on the default in-memory MemoryStore, tracking request
 * counts locally in the Node.js process memory. In a multi-replica or clustered production
 * deployment, rate limit quotas are not shared across processes without an external
 * distributed store (such as Redis via rate-limit-redis). For single-instance container
 * architectures, this in-memory strategy protects critical routes with zero network overhead.
 *
 * Reverse Proxy & Header Spoofing Consideration:
 * Express 'trust proxy' is disabled by default. The limiter resolves the client IP directly
 * from the socket remote address (req.ip). Untrusted client-supplied headers such as
 * X-Forwarded-For or X-Real-IP are ignored unless Express trust proxy is explicitly configured
 * behind a verified reverse proxy.
 */
function createRateLimiter({
  windowMs = 60 * 1000,
  max = 5,
  message = 'Too many requests. Please try again later.',
  statusCode = 429,
} = {}) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true, // draft-6/draft-7 RateLimit-* headers
    legacyHeaders: false, // Disable X-RateLimit-* headers
    statusCode,
    validate: {
      xForwardedForHeader: false, // Trust proxy is intentionally disabled; ignore header without warning
    },
    handler: (req, res, next, options) => {
      res.status(options.statusCode).json({
        ok: false,
        error: typeof options.message === 'string'
          ? options.message
          : options.message?.error || message,
      });
    },
    message: {
      ok: false,
      error: message,
    },
  });
}

function resolveLimit(envKey, prodDefault, testDefault = 100) {
  if (process.env[envKey] !== undefined) {
    const parsed = parseInt(process.env[envKey], 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return process.env.NODE_ENV === 'test' ? testDefault : prodDefault;
}

// 5 attempts per IP per minute for login
const loginLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: (req, res) => resolveLimit('RATE_LIMIT_LOGIN_MAX', 5, 100),
  message: 'Too many login attempts. Please try again later.',
});

// 5 attempts per IP per minute for register
const registerLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: (req, res) => resolveLimit('RATE_LIMIT_REGISTER_MAX', 5, 100),
  message: 'Too many registration attempts. Please try again later.',
});

// 20 requests per IP per minute for execute
const executeLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: (req, res) => resolveLimit('RATE_LIMIT_EXECUTE_MAX', 20, 200),
  message: 'Execution rate limit exceeded. Please wait before submitting more code.',
});

module.exports = {
  createRateLimiter,
  loginLimiter,
  registerLimiter,
  executeLimiter,
};
