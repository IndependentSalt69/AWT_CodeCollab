const roomDrivers = new Map();

function getDriver(roomId) {
  if (!roomId || typeof roomId !== 'string') return null;
  return roomDrivers.get(roomId) || null;
}

function setDriver(roomId, socketId) {
  if (!roomId) return;
  if (!socketId) {
    roomDrivers.delete(roomId);
  } else {
    roomDrivers.set(roomId, socketId);
  }
}

function removeDriver(roomId) {
  if (!roomId) return;
  roomDrivers.delete(roomId);
}

function getRemainingMembers(roomId, io, excludeSocketId = null) {
  if (!io?.sockets?.adapter?.rooms) return [];
  const members = io.sockets.adapter.rooms.get(roomId);
  if (!members || members.size === 0) {
    return [];
  }
  const memberList = Array.from(members);
  if (excludeSocketId) {
    return memberList.filter((id) => id !== excludeSocketId);
  }
  return memberList;
}

function getFirstMember(roomId, io, excludeSocketId = null) {
  const members = getRemainingMembers(roomId, io, excludeSocketId);
  return members.length > 0 ? members[0] : null;
}

function clearRoomIfEmpty(roomId, io, excludeSocketId = null) {
  const members = getRemainingMembers(roomId, io, excludeSocketId);
  if (members.length === 0) {
    removeDriver(roomId);
    return true;
  }
  return false;
}

function handleUserJoin(roomId, socketId, io) {
  if (!roomId || !socketId) {
    return { driverId: null, isNewDriver: false };
  }

  const currentDriver = getDriver(roomId);
  const roomMembers = getRemainingMembers(roomId, io);

  if (!currentDriver || !roomMembers.includes(currentDriver)) {
    setDriver(roomId, socketId);
    return { driverId: socketId, isNewDriver: true };
  }

  return { driverId: currentDriver, isNewDriver: false };
}

function handleUserLeave(roomId, leavingSocketId, io) {
  if (!roomId) {
    return { driverId: null, driverChanged: false };
  }

  const remaining = getRemainingMembers(roomId, io, leavingSocketId);

  if (remaining.length === 0) {
    removeDriver(roomId);
    return { driverId: null, driverChanged: true };
  }

  const currentDriver = getDriver(roomId);
  if (currentDriver === leavingSocketId || !remaining.includes(currentDriver)) {
    const nextDriver = remaining[0];
    setDriver(roomId, nextDriver);
    return { driverId: nextDriver, driverChanged: true };
  }

  return { driverId: currentDriver, driverChanged: false };
}

function transferDriver(roomId, newDriverId, io, requesterSocketId = null) {
  if (!roomId || typeof roomId !== 'string') {
    return { ok: false, error: 'roomId is required' };
  }
  if (!newDriverId || typeof newDriverId !== 'string') {
    return { ok: false, error: 'newDriverId is required' };
  }

  const currentDriver = getDriver(roomId);
  if (requesterSocketId && currentDriver && requesterSocketId !== currentDriver) {
    return { ok: false, error: 'Only the current driver can transfer the driver role' };
  }

  const roomMembers = getRemainingMembers(roomId, io);
  if (!roomMembers.includes(newDriverId)) {
    return { ok: false, error: 'Target user is not in the room' };
  }

  setDriver(roomId, newDriverId);
  return { ok: true, driverId: newDriverId };
}

module.exports = {
  getDriver,
  setDriver,
  removeDriver,
  getRemainingMembers,
  getFirstMember,
  clearRoomIfEmpty,
  handleUserJoin,
  handleUserLeave,
  transferDriver,
};