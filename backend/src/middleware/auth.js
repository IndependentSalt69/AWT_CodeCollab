const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_key_12345';

/**
 * Middleware to verify JWT authentication token in Authorization header.
 */
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      ok: false,
      error: 'Authentication required. No token provided.',
    });
  }

  const token = authHeader.split(' ')[1];

  if (!token || !token.trim()) {
    return res.status(401).json({
      ok: false,
      error: 'Authentication required. Invalid token format.',
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        ok: false,
        error: 'Authentication token has expired',
      });
    }
    return res.status(401).json({
      ok: false,
      error: 'Invalid authentication token',
    });
  }
}

/**
 * Helper to generate signed JWT for tests and user sessions.
 */
function generateToken(payload, expiresIn = '1h') {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

module.exports = {
  authenticate,
  generateToken,
  JWT_SECRET,
};
