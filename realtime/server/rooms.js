module.exports = function registerRoomHandlers(io, socket) {
  socket.on('room:join', ({ roomId, user }) => {
    socket.join(roomId);
    socket.to(roomId).emit('room:user_joined', { user, socketId: socket.id });
  });

  socket.on('room:leave', ({ roomId, user }) => {
    socket.leave(roomId);
    socket.to(roomId).emit('room:user_left', { user, socketId: socket.id });
  });
};
