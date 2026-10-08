const { getDriver, transferDriver } = require('./driverState');

module.exports = function registerEditorHandlers(io, socket) {
  socket.on('editor:change', ({ roomId, code, language, cursor } = {}) => {
    if (!roomId) return;
    const currentDriver = getDriver(roomId);
    if (currentDriver && currentDriver !== socket.id) {
      return;
    }
    socket.to(roomId).emit('editor:update', {
      code,
      language,
      cursor,
      updatedBy: socket.id,
    });
  });

  socket.on('editor:driver_change', ({ roomId, newDriverId } = {}, callback) => {
    const result = transferDriver(roomId, newDriverId, io, socket.id);
    if (result.ok) {
      io.to(roomId).emit('editor:driver_updated', { driverId: result.driverId, roomId });
      callback?.({ ok: true, driverId: result.driverId, roomId });
    } else {
      callback?.({ ok: false, error: result.error });
    }
  });
};
