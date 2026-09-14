module.exports = function registerTypingHandlers(io, socket) {
  socket.on('typing:start', ({ roomId, user }) => {
    socket.to(roomId).emit('typing:user_typing', { user });
  });

  socket.on('typing:stop', ({ roomId, user }) => {
    socket.to(roomId).emit('typing:user_stopped', { user });
  });
};
