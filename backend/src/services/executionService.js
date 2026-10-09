const mongoose = require('mongoose');
const executionQueue = require('../../../execution/engine/queue');
const ExecutionRun = require('../../../database/models/ExecutionRun');
const Room = require('../../../database/models/Room');
const { getDriver, getRemainingMembers } = require('../../../realtime/server/driverState');

const SUPPORTED_LANGUAGES = ['python', 'java', 'cpp'];
const EXECUTABLE_LANGUAGES = ['python']; // Languages with dynamic container runner implemented

/**
 * Checks if the user / socket is the active Driver of the given room.
 */
async function verifyDriverPermission({ roomId, user, socketId, io }) {
  const currentDriverSocketId = getDriver(roomId);

  // 1. Check Real-Time Session Driver State
  if (currentDriverSocketId) {
    if (!io || !io.sockets) {
      return { authorized: false, error: 'Realtime engine unavailable', status: 500 };
    }

    const driverSocket = io.sockets.sockets.get(currentDriverSocketId);
    if (!driverSocket) {
      return { authorized: false, error: 'Driver socket session not found', status: 404 };
    }

    // Retrieve driver socket user identity
    const driverUser =
      driverSocket.data?.roomVerifiedUsers?.get(roomId) ||
      driverSocket.data?.verifiedUser ||
      driverSocket.data?.roomMemberships?.get(roomId) ||
      driverSocket.data?.user;

    // Fail closed if driver session has no bound user identity
    if (!driverUser) {
      return {
        authorized: false,
        error: 'Driver session is not authenticated with a verified user identity',
        status: 403,
      };
    }

    // If client supplied a socketId, verify it matches driver socket first
    if (socketId && socketId !== currentDriverSocketId) {
      return {
        authorized: false,
        error: 'Only the active room driver can execute code',
        status: 403,
      };
    }

    // Verify authenticated HTTP user matches the driver socket identity
    const driverUserId = driverUser._id || driverUser.id || driverUser.userId;
    const reqUserId = user?._id || user?.id || user?.userId;
    const driverUsername = driverUser.username || driverUser.name;
    const reqUsername = user?.username || user?.name;

    const idMatch = driverUserId && reqUserId && String(driverUserId) === String(reqUserId);
    const nameMatch = driverUsername && reqUsername && driverUsername === reqUsername;

    if (!idMatch && !nameMatch) {
      return {
        authorized: false,
        error: 'Authenticated user does not match the active room driver session',
        status: 403,
      };
    }

    return { authorized: true };
  }

  // 2. If no realtime session exists, check Database Room record (if DB connected)
  if (mongoose.connection.readyState === 1) {
    const roomDoc = await Room.findOne({ roomId });
    if (roomDoc) {
      const driverOrOwnerId = roomDoc.activeDriver || roomDoc.owner;
      const reqUserId = user?._id || user?.id || user?.userId;
      if (driverOrOwnerId && reqUserId && String(driverOrOwnerId) === String(reqUserId)) {
        return { authorized: true };
      }
      return { authorized: false, error: 'User is not the active driver of this room', status: 403 };
    }
  }

  return { authorized: false, error: 'Room not found or no active driver assigned', status: 404 };
}

/**
 * Validates execution request payload parameters.
 */
function validateExecutionRequest({ roomId, language, code, timeout, memory }) {
  if (!roomId || typeof roomId !== 'string' || !roomId.trim()) {
    return { valid: false, error: 'roomId is required and must be a non-empty string' };
  }

  if (!language || typeof language !== 'string' || !language.trim()) {
    return { valid: false, error: 'language is required and must be a string' };
  }

  const normalizedLang = language.toLowerCase().trim();
  if (!SUPPORTED_LANGUAGES.includes(normalizedLang)) {
    return {
      valid: false,
      error: `Unsupported language: '${language}'. Supported languages: ${SUPPORTED_LANGUAGES.join(', ')}`,
    };
  }

  if (!EXECUTABLE_LANGUAGES.includes(normalizedLang)) {
    return {
      valid: false,
      error: `Execution for '${language}' is not yet supported in this milestone. Currently executable: ${EXECUTABLE_LANGUAGES.join(', ')}`,
    };
  }

  if (typeof code !== 'string') {
    return { valid: false, error: 'code must be a string' };
  }

  if (timeout !== undefined && timeout !== null) {
    if (typeof timeout !== 'number' || isNaN(timeout) || timeout <= 0) {
      return { valid: false, error: 'timeout must be a positive number in milliseconds' };
    }
  }

  if (memory !== undefined && memory !== null) {
    if (typeof memory !== 'string' && typeof memory !== 'number') {
      return { valid: false, error: 'memory must be a string (e.g. 256m) or number in bytes' };
    }
  }

  return { valid: true, normalizedLang };
}

/**
 * Converts user ID to Mongoose ObjectId safely.
 */
function toObjectId(id) {
  if (id && mongoose.Types.ObjectId.isValid(id)) {
    return new mongoose.Types.ObjectId(id);
  }
  return new mongoose.Types.ObjectId();
}

/**
 * Orchestrates code execution through authentication, validation, queueing, persistence, and realtime broadcasts.
 */
async function executeCodeService({ roomId, language, code, timeout, memory, user, socketId, io }) {
  // 1. Validation
  const validation = validateExecutionRequest({ roomId, language, code, timeout, memory });
  if (!validation.valid) {
    const error = new Error(validation.error);
    error.status = 400;
    throw error;
  }

  const normalizedLang = validation.normalizedLang;

  // 2. Authorization (Driver check)
  const authCheck = await verifyDriverPermission({ roomId, user, socketId, io });
  if (!authCheck.authorized) {
    const error = new Error(authCheck.error);
    error.status = authCheck.status || 403;
    throw error;
  }

  const triggeredBy = toObjectId(user?._id || user?.id || user?.userId);

  // 3. Persist initial ExecutionRun document (status: queued)
  let executionRun = null;
  const isDbConnected = mongoose.connection.readyState === 1;

  if (isDbConnected) {
    executionRun = new ExecutionRun({
      roomId,
      triggeredBy,
      language: normalizedLang,
      code,
      status: 'queued',
      stdout: '',
      stderr: '',
      exitCode: 0,
      executionTimeMs: 0,
    });
    await executionRun.save();
  } else {
    // Fallback object if running in unit tests without database connection
    executionRun = {
      _id: new mongoose.Types.ObjectId(),
      roomId,
      triggeredBy,
      language: normalizedLang,
      code,
      status: 'queued',
      stdout: '',
      stderr: '',
      exitCode: 0,
      executionTimeMs: 0,
      createdAt: new Date(),
    };
  }

  const runId = executionRun._id.toString();

  // 4. Realtime Broadcast: execution:started
  if (io) {
    io.to(roomId).emit('execution:started', {
      runId,
      roomId,
      status: 'queued',
      language: normalizedLang,
      triggeredBy: user?._id || user?.id || triggeredBy.toString(),
      createdAt: executionRun.createdAt ? executionRun.createdAt.toISOString() : new Date().toISOString(),
    });
  }

  // 5. Execute via BullMQ Queue / Worker
  // Ensure queue worker is initialized
  executionQueue.startWorker();

  let execResult;
  try {
    execResult = await executionQueue.execute({
      language: normalizedLang,
      code,
      timeout,
      memory,
      roomId,
      userId: triggeredBy.toString(),
    });
  } catch (queueErr) {
    // Handle queue failure
    if (isDbConnected && executionRun.save) {
      executionRun.status = 'failed';
      executionRun.stderr = queueErr.message;
      await executionRun.save();
    }

    if (io) {
      io.to(roomId).emit('execution:failed', {
        runId,
        roomId,
        status: 'failed',
        stdout: '',
        stderr: queueErr.message,
        exitCode: 1,
        executionTimeMs: 0,
        language: normalizedLang,
        triggeredBy: user?._id || user?.id || triggeredBy.toString(),
        error: queueErr.message,
      });
    }

    const error = new Error(`Execution queue failure: ${queueErr.message}`);
    error.status = 500;
    throw error;
  }

  // 6. Update ExecutionRun with final result
  const finalStatus = execResult.status || (execResult.exitCode === 0 ? 'completed' : 'failed');
  const stdout = execResult.stdout || '';
  const stderr = execResult.stderr || '';
  const exitCode = typeof execResult.exitCode === 'number' ? execResult.exitCode : 0;
  const executionTimeMs = execResult.executionTimeMs || 0;

  if (isDbConnected && executionRun.save) {
    executionRun.status = finalStatus;
    executionRun.stdout = stdout;
    executionRun.stderr = stderr;
    executionRun.exitCode = exitCode;
    executionRun.executionTimeMs = executionTimeMs;
    await executionRun.save();
  } else {
    executionRun.status = finalStatus;
    executionRun.stdout = stdout;
    executionRun.stderr = stderr;
    executionRun.exitCode = exitCode;
    executionRun.executionTimeMs = executionTimeMs;
  }

  // 7. Realtime Broadcast: execution:completed or execution:failed
  const eventPayload = {
    runId,
    roomId,
    status: finalStatus,
    stdout,
    stderr,
    exitCode,
    executionTimeMs,
    language: normalizedLang,
    triggeredBy: user?._id || user?.id || triggeredBy.toString(),
    error: execResult.error || undefined,
  };

  if (io) {
    if (finalStatus === 'completed') {
      io.to(roomId).emit('execution:completed', eventPayload);
    } else {
      io.to(roomId).emit('execution:failed', eventPayload);
    }
  }

  // 8. Return response
  return {
    ok: true,
    runId,
    status: finalStatus,
    result: {
      stdout,
      stderr,
      exitCode,
      executionTimeMs,
      status: finalStatus,
    },
    run: executionRun,
  };
}

module.exports = {
  executeCodeService,
  verifyDriverPermission,
  validateExecutionRequest,
  SUPPORTED_LANGUAGES,
  EXECUTABLE_LANGUAGES,
};
