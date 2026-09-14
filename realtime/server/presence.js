module.exports = function registerPresenceHandlers(io, socket) {
  socket.on('presence:ping', ({ roomId, user }) => {
    socket.to(roomId).emit('presence:heartbeat', { user, timestamp: Date.now() });
  });

  socket.on('presence:status', ({ roomId, status, user }) => {
    socket.to(roomId).emit('presence:status_changed', { user, status });
  });
};
