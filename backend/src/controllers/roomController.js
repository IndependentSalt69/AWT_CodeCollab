const roomService = require('../services/roomService');
const roomHistoryService = require('../services/roomHistoryService');
const voiceService = require('../services/voiceService');

function getUserId(req) {
  return req.user?.userId || req.user?.id || req.user?._id;
}

/**
 * Sends an error response. Intentional errors (4xx, 503) keep their message;
 * unexpected server errors are logged and replaced with a generic message.
 */
function sendError(res, err, fallbackMessage) {
  const status = err.status || 500;
  if (status === 500) {
    console.error(`[Rooms] ${fallbackMessage}: ${err.message}`);
    return res.status(status).json({ ok: false, error: fallbackMessage });
  }
  return res.status(status).json({ ok: false, error: err.message || fallbackMessage });
}

/**
 * Controller for POST /api/rooms
 * Creates a new room. Authenticated user becomes owner & first member.
 */
async function createRoomController(req, res) {
  try {
    const { name, language, isPrivate } = req.body || {};
    const room = await roomService.createRoom({ name, language, isPrivate }, getUserId(req));
    return res.status(201).json({ ok: true, room });
  } catch (err) {
    return sendError(res, err, 'Failed to create room');
  }
}

/**
 * Controller for GET /api/rooms
 * Lists all rooms where the authenticated user is an owner or member.
 */
async function listRoomsController(req, res) {
  try {
    const rooms = await roomService.listUserRooms(getUserId(req));
    return res.status(200).json({ ok: true, rooms });
  } catch (err) {
    return sendError(res, err, 'Failed to list rooms');
  }
}

/**
 * Controller for GET /api/rooms/:roomId
 * Returns details for a specific room if the requester is a member.
 */
async function getRoomController(req, res) {
  try {
    const room = await roomService.getRoomDetails(req.params.roomId, getUserId(req));
    return res.status(200).json({ ok: true, room });
  } catch (err) {
    return sendError(res, err, 'Failed to fetch room details');
  }
}

/**
 * Controller for POST /api/rooms/:roomId/join (and POST /api/rooms/join)
 * Joins an existing room using its stable identifier or join code. Idempotent.
 * If the room is private, requires valid inviteCode in req.body.
 */
async function joinRoomController(req, res) {
  try {
    const targetRoomId = req.params.roomId || req.body?.roomId || req.body?.joinCode;
    const inviteCode = req.body?.inviteCode || req.body?.code;
    const room = await roomService.joinRoom(targetRoomId, getUserId(req), { inviteCode });
    return res.status(200).json({ ok: true, room });
  } catch (err) {
    return sendError(res, err, 'Failed to join room');
  }
}

/**
 * Controller for GET /api/rooms/:roomId/invite
 * Retrieves the invite code for a private room (owner only).
 */
async function getRoomInviteController(req, res) {
  try {
    const inviteCode = await roomService.getRoomInvite(req.params.roomId, getUserId(req));
    return res.status(200).json({ ok: true, inviteCode });
  } catch (err) {
    return sendError(res, err, 'Failed to fetch invite code');
  }
}

/**
 * Controller for POST /api/rooms/:roomId/invite/rotate
 * Rotates the invite code for a private room (owner only).
 */
async function rotateRoomInviteController(req, res) {
  try {
    const inviteCode = await roomService.rotateRoomInvite(req.params.roomId, getUserId(req));
    return res.status(200).json({ ok: true, inviteCode });
  } catch (err) {
    return sendError(res, err, 'Failed to rotate invite code');
  }
}

/**
 * Controller for GET /api/rooms/:roomId/messages
 * Returns persisted chat history (newest first) to room members.
 */
async function listRoomMessagesController(req, res) {
  try {
    const room = await roomService.getRoomDetails(req.params.roomId, getUserId(req));
    const result = await roomHistoryService.listRoomMessages(room.roomId, req.query);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return sendError(res, err, 'Failed to fetch chat history');
  }
}

/**
 * Controller for GET /api/rooms/:roomId/executions
 * Returns execution history (newest first) to room members.
 */
async function listRoomExecutionsController(req, res) {
  try {
    const room = await roomService.getRoomDetails(req.params.roomId, getUserId(req));
    const result = await roomHistoryService.listRoomExecutions(room.roomId, req.query);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return sendError(res, err, 'Failed to fetch execution history');
  }
}

/**
 * Controller for POST /api/rooms/:roomId/voice-token
 * Issues a short-lived voice token to room members.
 */
async function createVoiceTokenController(req, res) {
  try {
    const userId = getUserId(req);
    const room = await roomService.getRoomDetails(req.params.roomId, userId);
    const voice = voiceService.createVoiceToken({
      roomId: room.roomId,
      userId,
      username: req.user?.username,
    });
    return res.status(200).json({ ok: true, ...voice });
  } catch (err) {
    return sendError(res, err, 'Failed to create voice token');
  }
}

module.exports = {
  createRoomController,
  listRoomsController,
  getRoomController,
  joinRoomController,
  getRoomInviteController,
  rotateRoomInviteController,
  listRoomMessagesController,
  listRoomExecutionsController,
  createVoiceTokenController,
};
