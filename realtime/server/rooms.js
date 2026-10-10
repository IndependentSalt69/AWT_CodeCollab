const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../../backend/src/middleware/auth');
const { handleUserJoin, handleUserLeave } = require('./driverState');
const Room = require('../../database/models/Room');

module.exports = function registerRoomHandlers(io, socket) {
  const memberships = new Map();
  const roomVerifiedUsers = new Map();
  socket.data.roomMemberships = memberships;
  socket.data.roomVerifiedUsers = roomVerifiedUsers;

  socket.on('room:join', async ({ roomId, user, token } = {}, callback) => {
    if (!roomId || typeof roomId !== 'string' || !roomId.trim()) {
      callback?.({
        ok: false,
        error: 'roomId is required',
      });
      return;
    }

    let verifiedUser = socket.data.verifiedUser || null;

    if (!verifiedUser && token) {
      try {
        verifiedUser = jwt.verify(token, getJwtSecret());
        socket.data.user = verifiedUser;
        socket.data.verifiedUser = verifiedUser;
        socket.data.authenticated = true;
      } catch (_) {
        verifiedUser = null;
      }
    }

    // 1. Enforce authenticated caller identity
    const rawCallerId = verifiedUser && (verifiedUser.userId || verifiedUser.id || verifiedUser._id);
    if (!verifiedUser || !rawCallerId) {
      callback?.({
        ok: false,
        error: 'Authentication required to join this room',
      });
      return;
    }

    // 2. Fail closed if database is disconnected or unavailable
    if (mongoose.connection.readyState !== 1) {
      callback?.({
        ok: false,
        error: 'Database connection error: service unavailable',
      });
      return;
    }

    // 3. Database persistent room lookup
    let roomDoc = null;
    try {
      const query = mongoose.Types.ObjectId.isValid(roomId)
        ? { $or: [{ roomId }, { _id: roomId }] }
        : { roomId };
      roomDoc = await Room.findOne(query);
    } catch (err) {
      callback?.({
        ok: false,
        error: 'Database error occurred during room authorization',
      });
      return;
    }

    // 4. Reject unknown rooms
    if (!roomDoc) {
      callback?.({
        ok: false,
        error: 'Room not found',
      });
      return;
    }

    // 5. Verify room membership or ownership
    const callerId = String(rawCallerId);
    const isOwner = roomDoc.owner && String(roomDoc.owner._id || roomDoc.owner) === callerId;
    const isMember = Array.isArray(roomDoc.members) && roomDoc.members.some(
      (m) => String(m._id || m) === callerId
    );

    if (!isOwner && !isMember) {
      callback?.({
        ok: false,
        error: 'Access denied: You are not a member of this room',
      });
      return;
    }

    // 6. Secure identity binding derived strictly from verified state
    const effectiveUser = {
      _id: callerId,
      id: callerId,
      userId: callerId,
      username: verifiedUser.username || verifiedUser.name || 'Anonymous',
      email: verifiedUser.email || '',
      name: verifiedUser.name || verifiedUser.username || 'Anonymous',
    };

    roomVerifiedUsers.set(roomId, effectiveUser);
    const alreadyJoined = memberships.has(roomId);
    memberships.set(roomId, effectiveUser);
    socket.join(roomId);

    const { driverId, isNewDriver } = handleUserJoin(roomId, socket.id, io);

    const members = [...(io.sockets.adapter.rooms.get(roomId) || [])]
      .map((socketId) => {
        const peer = io.sockets.sockets.get(socketId);
        return peer?.data.roomMemberships?.has(roomId)
          ? { socketId, user: peer.data.roomMemberships.get(roomId) }
          : null;
      })
      .filter(Boolean);

    socket.emit('room:members', { roomId, members });

    if (isNewDriver) {
      io.to(roomId).emit('editor:driver_updated', { driverId, roomId });
    } else if (driverId) {
      socket.emit('editor:driver_updated', { driverId, roomId });
    }

    callback?.({
      ok: true,
      roomId,
      socketId: socket.id,
    });

    if (!alreadyJoined) {
      socket.to(roomId).emit('room:user_joined', {
        user: effectiveUser,
        socketId: socket.id,
      });
    }

    console.log(`Socket ${socket.id} joined room ${roomId}`);
  });


  socket.on('room:leave', ({ roomId } = {}, callback) => {
    if (!roomId || typeof roomId !== 'string') {
      callback?.({
        ok: false,
        error: 'roomId is required',
      });
      return;
    }

    const wasJoined = memberships.has(roomId);
    const user = memberships.get(roomId);
    memberships.delete(roomId);
    roomVerifiedUsers.delete(roomId);
    socket.leave(roomId);

    const { driverId, driverChanged } = handleUserLeave(roomId, socket.id, io);

    callback?.({
      ok: true,
      roomId,
      socketId: socket.id,
    });

    if (wasJoined) {
      socket.to(roomId).emit('room:user_left', {
        user,
        socketId: socket.id,
      });

      if (driverChanged && driverId) {
        io.to(roomId).emit('editor:driver_updated', { driverId, roomId });
      }
    }

    console.log(`Socket ${socket.id} left room ${roomId}`);
  });

  socket.on('disconnecting', () => {
    for (const [roomId, user] of memberships) {
      const { driverId, driverChanged } = handleUserLeave(roomId, socket.id, io);
      socket.to(roomId).emit('room:user_left', { user, socketId: socket.id });

      if (driverChanged && driverId) {
        socket.to(roomId).emit('editor:driver_updated', { driverId, roomId });
      }
    }
    memberships.clear();
    roomVerifiedUsers.clear();
  });
};
