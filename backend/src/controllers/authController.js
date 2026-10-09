const authService = require('../services/authService');

/**
 * Controller for POST /api/auth/register
 */
async function registerController(req, res) {
  try {
    const { username, email, password } = req.body || {};
    const result = await authService.registerUser({ username, email, password });
    return res.status(201).json({
      ok: true,
      ...result,
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      ok: false,
      error: err.message || 'Registration failed',
    });
  }
}

/**
 * Controller for POST /api/auth/login
 */
async function loginController(req, res) {
  try {
    const { email, username, emailOrUsername, password } = req.body || {};
    const result = await authService.loginUser({
      email,
      username,
      emailOrUsername,
      password,
    });
    return res.status(200).json({
      ok: true,
      ...result,
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      ok: false,
      error: err.message || 'Login failed',
    });
  }
}

/**
 * Controller for GET /api/auth/me
 */
async function meController(req, res) {
  try {
    const userId = req.user?.userId || req.user?.id || req.user?._id;
    const user = await authService.getCurrentUser(userId);
    return res.status(200).json({
      ok: true,
      user,
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      ok: false,
      error: err.message || 'Failed to fetch current user profile',
    });
  }
}

module.exports = {
  registerController,
  loginController,
  meController,
};
