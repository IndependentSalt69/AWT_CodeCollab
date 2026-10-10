const ALLOWED_STATUSES = ['online', 'idle', 'away', 'busy'];

module.exports = function registerPresenceHandlers(io, socket) {
  socket.on('presence:ping', ({ roomId } = {}, callback) => {
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
      callback?.({ ok: false, error: 'Authentication required for presence' });
      return;
    }

    const safeUser = {
      id: String(verifiedUserId),
      userId: String(verifiedUserId),
      username: verifiedUser.username || verifiedUser.name || 'Anonymous',
      name: verifiedUser.name || verifiedUser.username || 'Anonymous',
      email: verifiedUser.email || '',
    };

    socket.to(roomId).emit('presence:heartbeat', {
      user: safeUser,
      timestamp: Date.now(),
      roomId,
      socketId: socket.id,
    });
    callback?.({ ok: true });
  });

  socket.on('presence:status', ({ roomId, status } = {}, callback) => {
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
      callback?.({ ok: false, error: 'Authentication required for presence status' });
      return;
    }

    const safeStatus =
      typeof status === 'string' && ALLOWED_STATUSES.includes(status.toLowerCase())
        ? status.toLowerCase()
        : 'online';

    const safeUser = {
      id: String(verifiedUserId),
      userId: String(verifiedUserId),
      username: verifiedUser.username || verifiedUser.name || 'Anonymous',
      name: verifiedUser.name || verifiedUser.username || 'Anonymous',
      email: verifiedUser.email || '',
    };

    socket.to(roomId).emit('presence:status_changed', {
      user: safeUser,
      status: safeStatus,
      roomId,
      socketId: socket.id,
    });
    callback?.({ ok: true });
  });
};

