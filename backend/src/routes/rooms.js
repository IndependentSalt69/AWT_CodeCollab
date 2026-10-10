const express = require('express');
const { authenticate } = require('../middleware/auth');
const {
  createRoomController,
  listRoomsController,
  getRoomController,
  joinRoomController,
} = require('../controllers/roomController');

const router = express.Router();

// All room management routes require JWT authentication
router.use(authenticate);

/**
 * @route   POST /api/rooms
 * @desc    Create a new room (authenticated user becomes owner and member)
 * @access  Private
 */
router.post('/', createRoomController);

/**
 * @route   GET /api/rooms
 * @desc    List rooms belonging to the authenticated user
 * @access  Private
 */
router.get('/', listRoomsController);

/**
 * @route   POST /api/rooms/join
 * @desc    Join an existing room using body { roomId } or { joinCode }
 * @access  Private
 */
router.post('/join', joinRoomController);

/**
 * @route   GET /api/rooms/:roomId
 * @desc    Get room details (allowed only if requester is a member)
 * @access  Private
 */
router.get('/:roomId', getRoomController);

/**
 * @route   POST /api/rooms/:roomId/join
 * @desc    Join an existing room by path param roomId/joinCode
 * @access  Private
 */
router.post('/:roomId/join', joinRoomController);

module.exports = router;
