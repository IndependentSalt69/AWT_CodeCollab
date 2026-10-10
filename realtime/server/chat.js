const MAX_MESSAGE_LENGTH = 2000;

module.exports = function registerChatHandlers(io, socket) {
  socket.on('chat:message_send', (payload, callback) => {
    if (!payload || typeof payload !== 'object') {
      callback?.({ ok: false, error: 'Payload must be an object' });
      return;
    }

    const { roomId, message } = payload;

    if (!roomId || typeof roomId !== 'string' || !roomId.trim()) {
      callback?.({ ok: false, error: 'roomId is required and must be a string' });
      return;
    }

    // 1. Verify socket is an active member of the room
    const isMember =
      Boolean(socket.rooms && socket.rooms.has(roomId)) &&
      Boolean(socket.data?.roomMemberships && socket.data.roomMemberships.has(roomId));

    if (!isMember) {
      callback?.({ ok: false, error: 'Sender is not a member of the room' });
      return;
    }

    // 2. Verify authenticated user identity bound to the room
    const verifiedUser =
      socket.data?.roomVerifiedUsers?.get(roomId) ||
      (socket.data?.authenticated ? socket.data.verifiedUser : null) ||
      socket.data?.roomMemberships?.get(roomId);

    const verifiedUserId =
      verifiedUser && (verifiedUser.userId || verifiedUser.id || verifiedUser._id);

    if (!verifiedUser || !verifiedUserId) {
      callback?.({
        ok: false,
        error: 'Authentication required to send messages in this room',
      });
      return;
    }

    // 3. Extract and validate message text content
    let text = '';
    if (typeof message === 'string') {
      text = message.trim();
    } else if (message && typeof message === 'object') {
      if (typeof message.text === 'string') {
        text = message.text.trim();
      } else if (typeof message.content === 'string') {
        text = message.content.trim();
      }
    }

    if (!text) {
      callback?.({ ok: false, error: 'Message text is required and cannot be empty' });
      return;
    }

    if (text.length > MAX_MESSAGE_LENGTH) {
      callback?.({
        ok: false,
        error: `Message exceeds maximum allowed length of ${MAX_MESSAGE_LENGTH} characters`,
      });
      return;
    }

    // 4. Derive sender identity strictly from server-side verified state
    const sender = {
      id: String(verifiedUserId),
      userId: String(verifiedUserId),
      username: verifiedUser.username || verifiedUser.name || 'Anonymous',
      name: verifiedUser.name || verifiedUser.username || 'Anonymous',
      email: verifiedUser.email || '',
    };

    const messagePayload = {
      text,
      content: text,
      sender,
      user: sender,
      roomId,
      timestamp: new Date().toISOString(),
      socketId: socket.id,
    };

    // 5. Broadcast message to room members
    io.to(roomId).emit('chat:message_received', messagePayload);
    callback?.({ ok: true, message: messagePayload });
  });
};

