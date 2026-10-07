module.exports = function registerRoomHandlers(io, socket) {
  const memberships = new Map();
  socket.data.roomMemberships = memberships;

  socket.on('room:join', ({ roomId, user } = {}, callback) => {
    if (!roomId || typeof roomId !== 'string') {
      callback?.({
        ok: false,
        error: 'roomId is required',
      });
      return;
    }

    const alreadyJoined = memberships.has(roomId);
    memberships.set(roomId, user);
    socket.join(roomId);

    const members = [...(io.sockets.adapter.rooms.get(roomId) || [])]
      .map((socketId) => {
        const peer = io.sockets.sockets.get(socketId);
        return peer?.data.roomMemberships?.has(roomId)
          ? { socketId, user: peer.data.roomMemberships.get(roomId) }
          : null;
      })
      .filter(Boolean);

    socket.emit('room:members', { roomId, members });

    callback?.({
      ok: true,
      roomId,
      socketId: socket.id,
    });

    if (!alreadyJoined) {
      socket.to(roomId).emit('room:user_joined', {
        user,
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
    }

    console.log(`Socket ${socket.id} left room ${roomId}`);
  });

  socket.on('disconnecting', () => {
    for (const [roomId, user] of memberships) {
      socket.to(roomId).emit('room:user_left', { user, socketId: socket.id });
    }
    memberships.clear();
  });
};
