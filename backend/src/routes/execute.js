const express = require('express');
const { authenticate } = require('../middleware/auth');
const { executeCodeController } = require('../controllers/executionController');
const { executeLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

/**
 * @route   POST /api/execute
 * @desc    Execute code in a sandboxed container for the active room driver (rate-limited)
 * @access  Private (Authenticated Driver only)
 */
router.post('/', executeLimiter, authenticate, executeCodeController);

module.exports = router;
