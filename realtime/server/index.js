const { Server } = require('socket.io');
const registerRoomHandlers = require('./rooms');
const registerEditorHandlers = require('./editorSync');
const registerPresenceHandlers = require('./presence');
const registerChatHandlers = require('./chat');
const registerTypingHandlers = require('./typing');
const driverState = require('./driverState');

const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../../backend/src/middleware/auth');

function initRealtimeServer(httpServer, corsOptions) {
  const io = new Server(httpServer, {
    cors: corsOptions || { origin: '*' },
  });

  // Verify handshake JWT token if provided
  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');

    if (token) {
      try {
        const decoded = jwt.verify(token, getJwtSecret());
        socket.data.user = decoded;
        socket.data.verifiedUser = decoded;
        socket.data.authenticated = true;
      } catch (err) {
        socket.data.authenticated = false;
        socket.data.user = null;
        socket.data.verifiedUser = null;
      }
    } else {
      socket.data.authenticated = false;
      socket.data.user = null;
      socket.data.verifiedUser = null;
    }
    next();
  });

  io.on('connection', (socket) => {
    registerRoomHandlers(io, socket);
    registerEditorHandlers(io, socket);
    registerPresenceHandlers(io, socket);
    registerChatHandlers(io, socket);
    registerTypingHandlers(io, socket);

    socket.on('disconnect', () => {
      // Disconnect handling
    });
  });

  return io;
}


module.exports = { initRealtimeServer, driverState };