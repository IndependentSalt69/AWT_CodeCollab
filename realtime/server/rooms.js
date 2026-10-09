const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../../backend/src/middleware/auth');
const { handleUserJoin, handleUserLeave } = require('./driverState');

module.exports = function registerRoomHandlers(io, socket) {
  const memberships = new Map();
  const roomVerifiedUsers = new Map();
  socket.data.roomMemberships = memberships;
  socket.data.roomVerifiedUsers = roomVerifiedUsers;

  socket.on('room:join', ({ roomId, user, token } = {}, callback) => {
    if (!roomId || typeof roomId !== 'string') {
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

    // Secure identity binding:
    // If the socket was verified via handshake or join token, use verified identity.
    // If unverified, user payload is recorded for display name only.
    const effectiveUser = verifiedUser
      ? {
          _id: verifiedUser.userId || verifiedUser.id || verifiedUser._id,
          id: verifiedUser.userId || verifiedUser.id || verifiedUser._id,
          userId: verifiedUser.userId || verifiedUser.id || verifiedUser._id,
          username: verifiedUser.username,
          email: verifiedUser.email,
          name: verifiedUser.username,
        }
      : user || null;

    if (verifiedUser) {
      roomVerifiedUsers.set(roomId, effectiveUser);
    }

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
  });
};
