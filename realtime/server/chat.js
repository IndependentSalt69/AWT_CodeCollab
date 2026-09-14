module.exports = function registerChatHandlers(io, socket) {
  socket.on('chat:message_send', ({ roomId, message }) => {
    io.to(roomId).emit('chat:message_received', {
      ...message,
      timestamp: new Date().toISOString(),
      socketId: socket.id,
    });
  });
};
