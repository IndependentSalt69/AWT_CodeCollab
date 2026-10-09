const { executeCodeService } = require('../services/executionService');

/**
 * Controller for handling POST /api/execute
 */
async function executeCodeController(req, res) {
  try {
    const { roomId, language, code, timeout, memory, socketId: bodySocketId } = req.body || {};
    const socketId = req.headers['x-socket-id'] || bodySocketId;
    const io = req.app.get('io') || req.io;

    const result = await executeCodeService({
      roomId,
      language,
      code,
      timeout,
      memory,
      user: req.user,
      socketId,
      io,
    });

    return res.status(200).json(result);
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      ok: false,
      error: err.message || 'Internal server error during code execution',
    });
  }
}

module.exports = {
  executeCodeController,
};
