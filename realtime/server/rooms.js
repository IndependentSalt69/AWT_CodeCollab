module.exports = function registerRoomHandlers(io, socket) {
  socket.on('room:join', ({ roomId, user }, callback) => {
    if (!roomId || typeof roomId !== 'string') {
      callback?.({
        ok: false,
        error: 'roomId is required',
      });
      return;
    }

    socket.join(roomId);

    callback?.({
      ok: true,
      roomId,
      socketId: socket.id,
    });

    socket.to(roomId).emit('room:user_joined', {
      user,
      socketId: socket.id,
    });

    console.log(`Socket ${socket.id} joined room ${roomId}`);
  });

  socket.on('room:leave', ({ roomId, user }, callback) => {
    if (!roomId || typeof roomId !== 'string') {
      callback?.({
        ok: false,
        error: 'roomId is required',
      });
      return;
    }

    socket.leave(roomId);

    callback?.({
      ok: true,
      roomId,
      socketId: socket.id,
    });

    socket.to(roomId).emit('room:user_left', {
      user,
      socketId: socket.id,
    });

    console.log(`Socket ${socket.id} left room ${roomId}`);
  });
};