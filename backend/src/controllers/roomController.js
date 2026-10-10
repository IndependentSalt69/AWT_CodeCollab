const roomService = require('../services/roomService');

/**
 * Controller for POST /api/rooms
 * Creates a new room. Authenticated user becomes owner & first member.
 */
async function createRoomController(req, res) {
  try {
    const userId = req.user?.userId || req.user?.id || req.user?._id;
    const { name, language, isPrivate } = req.body || {};

    const room = await roomService.createRoom({ name, language, isPrivate }, userId);
    return res.status(201).json({
      ok: true,
      room,
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      ok: false,
      error: err.message || 'Failed to create room',
    });
  }
}

/**
 * Controller for GET /api/rooms
 * Lists all rooms where the authenticated user is an owner or member.
 */
async function listRoomsController(req, res) {
  try {
    const userId = req.user?.userId || req.user?.id || req.user?._id;
    const rooms = await roomService.listUserRooms(userId);
    return res.status(200).json({
      ok: true,
      rooms,
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      ok: false,
      error: err.message || 'Failed to list rooms',
    });
  }
}

/**
 * Controller for GET /api/rooms/:roomId
 * Returns details for a specific room if the requester is a member.
 */
async function getRoomController(req, res) {
  try {
    const userId = req.user?.userId || req.user?.id || req.user?._id;
    const { roomId } = req.params;

    const room = await roomService.getRoomDetails(roomId, userId);
    return res.status(200).json({
      ok: true,
      room,
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      ok: false,
      error: err.message || 'Failed to fetch room details',
    });
  }
}

/**
 * Controller for POST /api/rooms/:roomId/join (and POST /api/rooms/join)
 * Joins an existing room using its stable identifier or join code. Idempotent.
 */
async function joinRoomController(req, res) {
  try {
    const userId = req.user?.userId || req.user?.id || req.user?._id;
    const targetRoomId = req.params.roomId || req.body?.roomId || req.body?.joinCode;

    const room = await roomService.joinRoom(targetRoomId, userId);
    return res.status(200).json({
      ok: true,
      room,
    });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      ok: false,
      error: err.message || 'Failed to join room',
    });
  }
}

module.exports = {
  createRoomController,
  listRoomsController,
  getRoomController,
  joinRoomController,
};
