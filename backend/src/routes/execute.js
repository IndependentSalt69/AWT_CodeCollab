const express = require('express');
const { authenticate } = require('../middleware/auth');
const { executeCodeController } = require('../controllers/executionController');

const router = express.Router();

/**
 * @route   POST /api/execute
 * @desc    Execute code in a sandboxed container for the active room driver
 * @access  Private (Authenticated Driver only)
 */
router.post('/', authenticate, executeCodeController);

module.exports = router;
