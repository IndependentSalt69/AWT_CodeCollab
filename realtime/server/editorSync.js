const { getDriver, transferDriver } = require('./driverState');

module.exports = function registerEditorHandlers(io, socket) {
  socket.on('editor:change', (payload, callback) => {
    if (!payload || typeof payload !== 'object') {
      callback?.({ ok: false, error: 'Payload must be an object' });
      return;
    }

    const { roomId, code, language, cursor } = payload;

    if (!roomId || typeof roomId !== 'string') {
      callback?.({ ok: false, error: 'roomId is required and must be a string' });
      return;
    }

    const isMember =
      Boolean(io.sockets.adapter.rooms.get(roomId)?.has(socket.id)) ||
      Boolean(socket.rooms.has(roomId));

    if (!isMember) {
      callback?.({ ok: false, error: 'Sender is not a member of the room' });
      return;
    }

    if (typeof code !== 'string') {
      callback?.({ ok: false, error: 'code must be a string' });
      return;
    }

    if (typeof language !== 'string' || !language.trim()) {
      callback?.({ ok: false, error: 'language must be a non-empty string' });
      return;
    }

    if (
      cursor !== undefined &&
      cursor !== null &&
      (typeof cursor !== 'object' || Array.isArray(cursor))
    ) {
      callback?.({ ok: false, error: 'cursor must be an object if provided' });
      return;
    }

    const currentDriver = getDriver(roomId);
    if (!currentDriver) {
      callback?.({ ok: false, error: 'No active driver for this room' });
      return;
    }

    if (currentDriver !== socket.id) {
      callback?.({ ok: false, error: 'Only the active driver can edit code' });
      return;
    }

    const updatePayload = {
      code,
      language,
      updatedBy: socket.id,
    };

    if (cursor !== undefined && cursor !== null) {
      updatePayload.cursor = cursor;
    }

    socket.to(roomId).emit('editor:update', updatePayload);
    callback?.({ ok: true });
  });

  socket.on('editor:driver_change', ({ roomId, newDriverId } = {}, callback) => {
    if (!roomId || typeof roomId !== 'string') {
      callback?.({ ok: false, error: 'roomId is required and must be a string' });
      return;
    }
    if (!newDriverId || typeof newDriverId !== 'string') {
      callback?.({ ok: false, error: 'newDriverId is required and must be a string' });
      return;
    }

    const result = transferDriver(roomId, newDriverId, io, socket.id);
    if (result.ok) {
      io.to(roomId).emit('editor:driver_updated', { driverId: result.driverId, roomId });
      callback?.({ ok: true, driverId: result.driverId, roomId });
    } else {
      callback?.({ ok: false, error: result.error });
    }
  });
};
