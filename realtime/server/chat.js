const mongoose = require('mongoose');
const Message = require('../../database/models/Message');

const MAX_MESSAGE_LENGTH = 2000;

// Simple per-socket flood control: at most 10 messages every 10 seconds
const RATE_LIMIT_WINDOW_MS = 10 * 1000;
const RATE_LIMIT_MAX_MESSAGES = 10;

function isRateLimited(socket) {
  const now = Date.now();
  const recent = (socket.data.chatTimestamps || []).filter(
    (ts) => now - ts < RATE_LIMIT_WINDOW_MS
  );
  if (recent.length >= RATE_LIMIT_MAX_MESSAGES) {
    socket.data.chatTimestamps = recent;
    return true;
  }
  recent.push(now);
  socket.data.chatTimestamps = recent;
  return false;
}

module.exports = function registerChatHandlers(io, socket) {
  socket.on('chat:message_send', async (payload, callback) => {
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

    if (isRateLimited(socket)) {
      callback?.({ ok: false, error: 'You are sending messages too quickly. Please slow down.' });
      return;
    }

    // 4. Derive sender identity strictly from server-side verified state
    const sender = {
      id: String(verifiedUserId),
      userId: String(verifiedUserId),
      username: verifiedUser.username || verifiedUser.name || 'Anonymous',
      name: verifiedUser.name || verifiedUser.username || 'Anonymous',
    };

    // 5. Persist before broadcasting so every delivered message is in history
    if (mongoose.connection.readyState !== 1) {
      callback?.({ ok: false, error: 'Chat is temporarily unavailable' });
      return;
    }

    let saved;
    try {
      saved = await Message.create({
        roomId,
        sender: sender.id,
        senderUsername: sender.username,
        content: text,
      });
    } catch (err) {
      console.error(`[Chat] Failed to save message for room ${roomId}: ${err.message}`);
      callback?.({ ok: false, error: 'Failed to send message' });
      return;
    }

    const messagePayload = {
      id: String(saved._id),
      text,
      content: text,
      sender,
      user: sender,
      roomId,
      timestamp: new Date(saved.createdAt || Date.now()).toISOString(),
      socketId: socket.id,
    };

    // 6. Broadcast message to room members
    io.to(roomId).emit('chat:message_received', messagePayload);
    callback?.({ ok: true, message: messagePayload });
  });
};
