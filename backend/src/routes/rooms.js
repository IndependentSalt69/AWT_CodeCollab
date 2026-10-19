const express = require('express');
const { authenticate } = require('../middleware/auth');
const { joinRoomLimiter } = require('../middleware/rateLimiter');
const {
  createRoomController,
  listRoomsController,
  getRoomController,
  joinRoomController,
  getRoomInviteController,
  rotateRoomInviteController,
  listRoomMessagesController,
  listRoomExecutionsController,
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
router.post('/join', joinRoomLimiter, joinRoomController);

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
router.post('/:roomId/join', joinRoomLimiter, joinRoomController);

/**
 * @route   GET /api/rooms/:roomId/invite
 * @desc    Plaintext cannot be retrieved from hash; informs client to use rotate endpoint
 * @access  Private
 */
router.get('/:roomId/invite', getRoomInviteController);

/**
 * @route   POST /api/rooms/:roomId/invite
 * @desc    Generate/rotate invite code for a private room (owner only)
 * @access  Private
 */
router.post('/:roomId/invite', rotateRoomInviteController);

/**
 * @route   POST /api/rooms/:roomId/invite/rotate
 * @desc    Rotate invite code for a private room (owner only)
 * @access  Private
 */
router.post('/:roomId/invite/rotate', rotateRoomInviteController);

/**
 * @route   GET /api/rooms/:roomId/messages
 * @desc    Paginated chat history, newest first (members only)
 * @access  Private
 */
router.get('/:roomId/messages', listRoomMessagesController);

/**
 * @route   GET /api/rooms/:roomId/executions
 * @desc    Paginated execution history, newest first (members only)
 * @access  Private
 */
router.get('/:roomId/executions', listRoomExecutionsController);

module.exports = router;
