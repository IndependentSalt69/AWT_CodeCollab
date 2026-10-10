module.exports = function registerTypingHandlers(io, socket) {
  socket.on('typing:start', ({ roomId } = {}, callback) => {
    if (!roomId || typeof roomId !== 'string' || !roomId.trim()) {
      callback?.({ ok: false, error: 'roomId is required and must be a string' });
      return;
    }

    const isMember =
      Boolean(socket.rooms && socket.rooms.has(roomId)) &&
      Boolean(socket.data?.roomMemberships && socket.data.roomMemberships.has(roomId));

    if (!isMember) {
      callback?.({ ok: false, error: 'Sender is not a member of the room' });
      return;
    }

    const verifiedUser =
      socket.data?.roomVerifiedUsers?.get(roomId) ||
      (socket.data?.authenticated ? socket.data.verifiedUser : null) ||
      socket.data?.roomMemberships?.get(roomId);

    const verifiedUserId =
      verifiedUser && (verifiedUser.userId || verifiedUser.id || verifiedUser._id);

    if (!verifiedUser || !verifiedUserId) {
      callback?.({ ok: false, error: 'Authentication required for typing indicator' });
      return;
    }

    const safeUser = {
      id: String(verifiedUserId),
      userId: String(verifiedUserId),
      username: verifiedUser.username || verifiedUser.name || 'Anonymous',
      name: verifiedUser.name || verifiedUser.username || 'Anonymous',
    };

    socket.to(roomId).emit('typing:user_typing', {
      user: safeUser,
      roomId,
      socketId: socket.id,
    });
    callback?.({ ok: true });
  });

  socket.on('typing:stop', ({ roomId } = {}, callback) => {
    if (!roomId || typeof roomId !== 'string' || !roomId.trim()) {
      callback?.({ ok: false, error: 'roomId is required and must be a string' });
      return;
    }

    const isMember =
      Boolean(socket.rooms && socket.rooms.has(roomId)) &&
      Boolean(socket.data?.roomMemberships && socket.data.roomMemberships.has(roomId));

    if (!isMember) {
      callback?.({ ok: false, error: 'Sender is not a member of the room' });
      return;
    }

    const verifiedUser =
      socket.data?.roomVerifiedUsers?.get(roomId) ||
      (socket.data?.authenticated ? socket.data.verifiedUser : null) ||
      socket.data?.roomMemberships?.get(roomId);

    const safeUser = verifiedUser
      ? {
          id: String(verifiedUser.userId || verifiedUser.id || verifiedUser._id),
          userId: String(verifiedUser.userId || verifiedUser.id || verifiedUser._id),
          username: verifiedUser.username || verifiedUser.name || 'Anonymous',
          name: verifiedUser.name || verifiedUser.username || 'Anonymous',
        }
      : null;

    socket.to(roomId).emit('typing:user_stopped', {
      user: safeUser,
      roomId,
      socketId: socket.id,
    });
    callback?.({ ok: true });
  });
};

