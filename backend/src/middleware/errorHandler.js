/**
 * Global Express Error Handling Middleware.
 *
 * Requirements (SEC-API-02):
 * - Must be mounted after all routes and middleware as the final 4-argument Express error handler.
 * - Preserves intentional client/operational responses: validation (400), authentication (401),
 *   authorization (403), not found (404), conflict (409), rate limit / queue capacity (429), etc.
 * - For unexpected internal errors (500), returns a stable sanitized JSON response without leaking
 *   stack traces, file paths, database connection strings, or raw exception messages.
 * - Logs diagnostic details on the server while defensively suppressing passwords, tokens,
 *   or sensitive payload fields.
 */

function sanitizeHeadersForLogging(headers = {}) {
  const safe = { ...headers };
  if (safe.authorization) {
    safe.authorization = '[REDACTED]';
  }
  if (safe.cookie) {
    safe.cookie = '[REDACTED]';
  }
  return safe;
}

function globalErrorHandler(err, req, res, next) {
  // If response headers were already sent, delegate to default Express handler
  if (res.headersSent) {
    return next(err);
  }

  // Determine HTTP status code
  const status = typeof err.status === 'number' && err.status >= 400 && err.status < 600
    ? err.status
    : typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600
    ? err.statusCode
    : 500;

  // Preserve intentional client errors (4xx)
  if (status < 500) {
    return res.status(status).json({
      ok: false,
      error: err.message || 'Client error',
    });
  }

  // Internal Server Error (500) - Sanitize completely for client
  const method = req.method || 'UNKNOWN';
  const url = req.originalUrl || req.url || '';
  const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';

  // Server-side diagnostic log (omitting secrets)
  console.error(`[InternalServerError] ${method} ${url} (IP: ${clientIp}): ${err.message || 'Unknown error'}`);
  if (process.env.NODE_ENV !== 'test' && err.stack) {
    console.error(err.stack);
  }

  return res.status(500).json({
    ok: false,
    error: 'Internal server error',
  });
}

module.exports = {
  globalErrorHandler,
};
