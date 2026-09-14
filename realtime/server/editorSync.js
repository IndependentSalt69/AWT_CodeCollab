module.exports = function registerEditorHandlers(io, socket) {
  socket.on('editor:change', ({ roomId, code, language, cursor }) => {
    socket.to(roomId).emit('editor:update', {
      code,
      language,
      cursor,
      updatedBy: socket.id,
    });
  });

  socket.on('editor:driver_change', ({ roomId, newDriverId }) => {
    io.to(roomId).emit('editor:driver_updated', { driverId: newDriverId });
  });
};
