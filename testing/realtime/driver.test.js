const http = require('http');
const { io: connect } = require('socket.io-client');
const { initRealtimeServer } = require('../../realtime/server');
const { getDriver } = require('../../realtime/server/driverState');

const nextEvent = (socket, event) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, 2000);
    const handler = (payload) => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(event, handler);
  });

const emitAck = (socket, event, payload) =>
  new Promise((resolve, reject) => {
    socket.timeout(2000).emit(event, payload, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });

describe('Driver state management lifecycle', () => {
  let io;
  let server;
  let clients;

  beforeEach(async () => {
    server = http.createServer();
    io = initRealtimeServer(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    clients = [0, 1, 2].map(() =>
      connect(`http://127.0.0.1:${server.address().port}`, {
        autoConnect: false,
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      })
    );
    await Promise.all(
      clients.map(async (client) => {
        const connected = nextEvent(client, 'connect');
        client.connect();
        await connected;
      })
    );
  });

  afterEach(async () => {
    clients.forEach((client) => client.disconnect());
    await new Promise((resolve) => io.close(resolve));
  });

  test('full driver lifecycle: empty -> A joins (Driver) -> B/C join (Viewers) -> A transfers to B -> B disconnects -> A/C becomes Driver -> all leave -> state removed', async () => {
    const [userA, userB, userC] = clients;
    const roomId = 'flow-room';

    // 1. Room empty -> driver state is null
    expect(getDriver(roomId)).toBeNull();

    // 2. User A joins -> A becomes Driver
    const driverEventA = nextEvent(userA, 'editor:driver_updated');
    await emitAck(userA, 'room:join', { roomId, user: { name: 'User A' } });
    const updateA = await driverEventA;
    expect(updateA.driverId).toBe(userA.id);
    expect(getDriver(roomId)).toBe(userA.id);

    // 3. User B joins -> B becomes Viewer (driver remains A)
    const driverEventB = nextEvent(userB, 'editor:driver_updated');
    await emitAck(userB, 'room:join', { roomId, user: { name: 'User B' } });
    const updateB = await driverEventB;
    expect(updateB.driverId).toBe(userA.id);
    expect(getDriver(roomId)).toBe(userA.id);

    // 4. User C joins -> C becomes Viewer (driver remains A)
    const driverEventC = nextEvent(userC, 'editor:driver_updated');
    await emitAck(userC, 'room:join', { roomId, user: { name: 'User C' } });
    const updateC = await driverEventC;
    expect(updateC.driverId).toBe(userA.id);
    expect(getDriver(roomId)).toBe(userA.id);

    // Verify Driver A can edit and viewers receive update
    const updateReceivedByB = nextEvent(userB, 'editor:update');
    userA.emit('editor:change', {
      roomId,
      code: 'console.log("hello")',
      language: 'javascript',
    });
    const codeUpdate = await updateReceivedByB;
    expect(codeUpdate.code).toBe('console.log("hello")');
    expect(codeUpdate.updatedBy).toBe(userA.id);

    // Verify Viewer B cannot broadcast edits
    const unexpectedUpdate = jest.fn();
    userA.on('editor:update', unexpectedUpdate);
    userB.emit('editor:change', {
      roomId,
      code: 'unauthorized edit',
      language: 'javascript',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unexpectedUpdate).not.toHaveBeenCalled();
    userA.off('editor:update', unexpectedUpdate);

    // 5. A transfers driver to B
    const driverUpdatedOnA = nextEvent(userA, 'editor:driver_updated');
    const driverUpdatedOnB = nextEvent(userB, 'editor:driver_updated');
    const driverUpdatedOnC = nextEvent(userC, 'editor:driver_updated');

    const transferAck = await emitAck(userA, 'editor:driver_change', {
      roomId,
      newDriverId: userB.id,
    });
    expect(transferAck.ok).toBe(true);
    expect(transferAck.driverId).toBe(userB.id);

    expect((await driverUpdatedOnA).driverId).toBe(userB.id);
    expect((await driverUpdatedOnB).driverId).toBe(userB.id);
    expect((await driverUpdatedOnC).driverId).toBe(userB.id);
    expect(getDriver(roomId)).toBe(userB.id);

    // 6. B disconnects -> A or C becomes Driver
    const driverReassignedA = nextEvent(userA, 'editor:driver_updated');
    const driverReassignedC = nextEvent(userC, 'editor:driver_updated');

    userB.disconnect();

    const reassignedA = await driverReassignedA;
    const reassignedC = await driverReassignedC;
    expect(reassignedA.driverId).toBe(reassignedC.driverId);
    expect([userA.id, userC.id]).toContain(reassignedA.driverId);
    expect(getDriver(roomId)).toBe(reassignedA.driverId);

    // 7. Remaining users leave -> driver state removed
    await emitAck(userA, 'room:leave', { roomId });
    // C is the only remaining user
    expect(getDriver(roomId)).toBe(userC.id);

    // Last user (C) leaves
    await emitAck(userC, 'room:leave', { roomId });
    // Room is empty -> driver state is removed
    expect(getDriver(roomId)).toBeNull();
  });

  test('handles explicit driver leave (room:leave) gracefully', async () => {
    const [userA, userB] = clients;
    const roomId = 'leave-room';

    await emitAck(userA, 'room:join', { roomId, user: { name: 'User A' } });
    await emitAck(userB, 'room:join', { roomId, user: { name: 'User B' } });
    expect(getDriver(roomId)).toBe(userA.id);

    // Driver (User A) explicitly leaves
    const driverUpdatedB = nextEvent(userB, 'editor:driver_updated');
    await emitAck(userA, 'room:leave', { roomId });

    const newDriverUpdate = await driverUpdatedB;
    expect(newDriverUpdate.driverId).toBe(userB.id);
    expect(getDriver(roomId)).toBe(userB.id);

    // User B leaves
    await emitAck(userB, 'room:leave', { roomId });
    expect(getDriver(roomId)).toBeNull();
  });

  test('viewer disconnecting does not change active driver', async () => {
    const [userA, userB] = clients;
    const roomId = 'viewer-disconnect-room';

    await emitAck(userA, 'room:join', { roomId, user: { name: 'User A' } });
    await emitAck(userB, 'room:join', { roomId, user: { name: 'User B' } });
    expect(getDriver(roomId)).toBe(userA.id);

    const unexpectedDriverUpdate = jest.fn();
    userA.on('editor:driver_updated', unexpectedDriverUpdate);

    // Viewer (User B) disconnects
    userB.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(unexpectedDriverUpdate).not.toHaveBeenCalled();
    expect(getDriver(roomId)).toBe(userA.id);
  });

  test('rejects driver transfer to non-existent or outside user', async () => {
    const [userA, userB] = clients;
    const roomId = 'reject-room';

    await emitAck(userA, 'room:join', { roomId, user: { name: 'User A' } });
    // userB has not joined 'reject-room'

    const res = await emitAck(userA, 'editor:driver_change', {
      roomId,
      newDriverId: userB.id,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not in the room/i);
    expect(getDriver(roomId)).toBe(userA.id);
  });

  test('rejects driver transfer from non-driver user', async () => {
    const [userA, userB, userC] = clients;
    const roomId = 'non-driver-transfer-room';

    await emitAck(userA, 'room:join', { roomId, user: { name: 'User A' } });
    await emitAck(userB, 'room:join', { roomId, user: { name: 'User B' } });
    await emitAck(userC, 'room:join', { roomId, user: { name: 'User C' } });

    // User B is a viewer, tries to transfer driver to C
    const res = await emitAck(userB, 'editor:driver_change', {
      roomId,
      newDriverId: userC.id,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/only the current driver/i);
    expect(getDriver(roomId)).toBe(userA.id);
  });
});
