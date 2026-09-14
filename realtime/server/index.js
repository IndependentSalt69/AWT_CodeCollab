const { Server } = require('socket.io');
const registerRoomHandlers = require('./rooms');
const registerEditorHandlers = require('./editorSync');
const registerPresenceHandlers = require('./presence');
const registerChatHandlers = require('./chat');
const registerTypingHandlers = require('./typing');

function initRealtimeServer(httpServer, corsOptions) {
  const io = new Server(httpServer, {
    cors: corsOptions || { origin: '*' },
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

module.exports = { initRealtimeServer };