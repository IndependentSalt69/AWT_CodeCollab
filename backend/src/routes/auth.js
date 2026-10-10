const express = require('express');
const { authenticate } = require('../middleware/auth');
const {
  registerController,
  loginController,
  meController,
} = require('../controllers/authController');
const { registerLimiter, loginLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

/**
 * @route   POST /api/auth/register
 * @desc    Register a new user account (rate-limited)
 * @access  Public
 */
router.post('/register', registerLimiter, registerController);

/**
 * @route   POST /api/auth/login
 * @desc    Authenticate user credentials and receive JWT (rate-limited)
 * @access  Public
 */
router.post('/login', loginLimiter, loginController);

/**
 * @route   GET /api/auth/me
 * @desc    Get current authenticated user profile
 * @access  Private (Bearer JWT required)
 */
router.get('/me', authenticate, meController);

module.exports = router;
