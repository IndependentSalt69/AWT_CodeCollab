const crypto = require('crypto');
const mongoose = require('mongoose');
const Room = require('../../../database/models/Room');

/**
 * Generates a clean, unique, URL-safe room identifier.
 * Example: 'algo-practice-f4a2'
 */
function generateRoomId(name) {
  const baseSlug = (name || 'room')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20);
  const randomSuffix = crypto.randomBytes(3).toString('hex');
  return baseSlug ? `${baseSlug}-${randomSuffix}` : `room-${randomSuffix}`;
}

/**
 * Normalizes a Room document into a safe API response payload.
 */
function sanitizeRoom(room) {
  if (!room) return null;
  const doc = typeof room.toObject === 'function' ? room.toObject() : room;
  return {
    id: doc._id?.toString() || doc.id,
    _id: doc._id?.toString() || doc.id,
    roomId: doc.roomId,
    name: doc.name,
    language: doc.language || 'python',
    isPrivate: Boolean(doc.isPrivate),
    currentCode: doc.currentCode || '',
    owner: doc.owner
      ? typeof doc.owner === 'object'
        ? {
            id: doc.owner._id?.toString() || doc.owner.id,
            _id: doc.owner._id?.toString() || doc.owner.id,
            username: doc.owner.username,
            email: doc.owner.email,
          }
        : doc.owner.toString()
      : null,
    members: Array.isArray(doc.members)
      ? doc.members.map((m) =>
          typeof m === 'object'
            ? {
                id: m._id?.toString() || m.id,
                _id: m._id?.toString() || m.id,
                username: m.username,
                email: m.email,
              }
            : m.toString()
        )
      : [],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Creates a new persistent room. The creator automatically becomes the owner and first member.
 */
async function createRoom({ name, language, isPrivate }, userId) {
  if (!userId) {
    const error = new Error('Authentication required');
    error.status = 401;
    throw error;
  }

  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!trimmedName || trimmedName.length === 0) {
    const error = new Error('Room name is required and cannot be empty');
    error.status = 400;
    throw error;
  }

  if (trimmedName.length > 100) {
    const error = new Error('Room name cannot exceed 100 characters');
    error.status = 400;
    throw error;
  }

  const supportedLanguages = ['python', 'java', 'cpp'];
  const effectiveLanguage = language && supportedLanguages.includes(language.toLowerCase())
    ? language.toLowerCase()
    : 'python';

  // Ensure unique roomId
  let uniqueRoomId = generateRoomId(trimmedName);
  let attempts = 0;
  while (attempts < 5) {
    const existing = await Room.findOne({ roomId: uniqueRoomId });
    if (!existing) break;
    uniqueRoomId = generateRoomId(trimmedName);
    attempts++;
  }

  try {
    const room = new Room({
      name: trimmedName,
      roomId: uniqueRoomId,
      owner: userId,
      members: [userId], // Creator automatically becomes a member!
      language: effectiveLanguage,
      isPrivate: Boolean(isPrivate),
    });

    await room.save();

    if (typeof room.populate === 'function') {
      await room.populate('owner', 'username email');
      await room.populate('members', 'username email');
    }

    return sanitizeRoom(room);
  } catch (err) {
    if (err.status) throw err;
    const dbError = new Error(err.message || 'Failed to create room in database');
    dbError.status = 500;
    throw dbError;
  }
}

/**
 * Lists all rooms where the user is an owner or member.
 */
async function listUserRooms(userId) {
  if (!userId) {
    const error = new Error('Authentication required');
    error.status = 401;
    throw error;
  }

  try {
    const query = {
      $or: [{ members: userId }, { owner: userId }],
    };

    const rooms = await Room.find(query)
      .sort({ updatedAt: -1 })
      .populate('owner', 'username email')
      .populate('members', 'username email');

    return rooms.map(sanitizeRoom);
  } catch (err) {
    if (err.status) throw err;
    const dbError = new Error(err.message || 'Failed to list rooms from database');
    dbError.status = 500;
    throw dbError;
  }
}

/**
 * Retrieves details for a specific room if the user is a member.
 */
async function getRoomDetails(roomIdOrId, userId) {
  if (!userId) {
    const error = new Error('Authentication required');
    error.status = 401;
    throw error;
  }

  if (!roomIdOrId || typeof roomIdOrId !== 'string') {
    const error = new Error('Room identifier is required');
    error.status = 400;
    throw error;
  }

  const query = mongoose.Types.ObjectId.isValid(roomIdOrId)
    ? { $or: [{ roomId: roomIdOrId }, { _id: roomIdOrId }] }
    : { roomId: roomIdOrId };

  let room;
  try {
    room = await Room.findOne(query)
      .populate('owner', 'username email')
      .populate('members', 'username email');
  } catch (err) {
    const dbError = new Error(err.message || 'Database error occurred while fetching room');
    dbError.status = 500;
    throw dbError;
  }

  if (!room) {
    const error = new Error('Room not found');
    error.status = 404;
    throw error;
  }

  const userIdStr = String(userId);
  const isOwner = room.owner && String(room.owner._id || room.owner) === userIdStr;
  const isMember = Array.isArray(room.members) && room.members.some(
    (m) => String(m._id || m) === userIdStr
  );

  if (!isOwner && !isMember) {
    const error = new Error('Access denied: You are not a member of this room');
    error.status = 403;
    throw error;
  }

  return sanitizeRoom(room);
}

/**
 * Joins a room using its roomId or join code. Membership addition is idempotent.
 */
async function joinRoom(roomIdOrId, userId) {
  if (!userId) {
    const error = new Error('Authentication required');
    error.status = 401;
    throw error;
  }

  const cleanIdentifier = typeof roomIdOrId === 'string' ? roomIdOrId.trim() : '';
  if (!cleanIdentifier) {
    const error = new Error('Room identifier or join code is required');
    error.status = 400;
    throw error;
  }

  const query = mongoose.Types.ObjectId.isValid(cleanIdentifier)
    ? { $or: [{ roomId: cleanIdentifier }, { _id: cleanIdentifier }] }
    : { roomId: cleanIdentifier };

  let room;
  try {
    room = await Room.findOne(query);
  } catch (err) {
    const dbError = new Error(err.message || 'Database error occurred while finding room');
    dbError.status = 500;
    throw dbError;
  }

  if (!room) {
    const error = new Error('Room not found');
    error.status = 404;
    throw error;
  }

  const userIdStr = String(userId);
  const isAlreadyMember = Array.isArray(room.members) && room.members.some(
    (m) => String(m._id || m) === userIdStr
  );

  if (!isAlreadyMember) {
    try {
      room.members.push(userId);
      await room.save();
    } catch (err) {
      const dbError = new Error(err.message || 'Failed to update room membership');
      dbError.status = 500;
      throw dbError;
    }
  }

  if (typeof room.populate === 'function') {
    await room.populate('owner', 'username email');
    await room.populate('members', 'username email');
  }

  return sanitizeRoom(room);
}

module.exports = {
  createRoom,
  listUserRooms,
  getRoomDetails,
  joinRoom,
  sanitizeRoom,
  generateRoomId,
};
