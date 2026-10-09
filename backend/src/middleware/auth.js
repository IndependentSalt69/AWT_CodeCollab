const jwt = require('jsonwebtoken');

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FATAL: JWT_SECRET environment variable must be defined in production');
    }
    return 'dev_secret_key_12345';
  }
  return secret;
}

const JWT_SECRET = getJwtSecret();

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
    const decoded = jwt.verify(token, getJwtSecret());
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
 * Helper to generate signed JWT for user sessions and tests.
 */
function generateToken(payload, expiresIn = '24h') {
  return jwt.sign(payload, getJwtSecret(), { expiresIn });
}

module.exports = {
  authenticate,
  generateToken,
  getJwtSecret,
  JWT_SECRET,
};
