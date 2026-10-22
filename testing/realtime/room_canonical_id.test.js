/**
 * Canonical room identity tests
 *
 * A room can be looked up by its roomId or its database _id. Sockets must always
 * be bound to the canonical roomId so the same room never ends up split across
 * two socket rooms with two different Drivers.
 */

const http = require('http');
const { io: connect } = require('socket.io-client');
const mongoose = require('mongoose');
const { initRealtimeServer } = require('../../realtime/server');
const { getDriver } = require('../../realtime/server/driverState');
const Room = require('../../database/models/Room');
const { generateToken } = require('../../backend/src/middleware/auth');

const nextEvent = (socket, event, timeoutMs = 2000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const emitAck = (socket, event, payload, timeoutMs = 2000) =>
  new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit(event, payload, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });

describe('Realtime canonical room identity', () => {
  let server;
  let io;
  let port;
  const clients = [];

  const userAlice = { id: '67056a1b2c3d4e5f6a7b8c01', userId: '67056a1b2c3d4e5f6a7b8c01', username: 'alice' };
  const userBob = { id: '67056a1b2c3d4e5f6a7b8c02', userId: '67056a1b2c3d4e5f6a7b8c02', username: 'bob' };
  const tokenAlice = generateToken(userAlice);
  const tokenBob = generateToken(userBob);

  const ROOM_OBJECT_ID = '67056a1b2c3d4e5f6a7b8d00';
  const room = {
    _id: ROOM_OBJECT_ID,
    roomId: 'pair-room-a1b2c3',
    owner: userAlice.id,
    members: [userAlice.id, userBob.id],
  };

  beforeAll(async () => {
    jest.spyOn(Room, 'findOne').mockImplementation((query) => {
      const conditions = query.$or || [query];
      const match = conditions.some(
        (c) => c.roomId === room.roomId || String(c._id) === ROOM_OBJECT_ID
      );
      return Promise.resolve(match ? room : null);
    });

    mongoose.connection.readyState = 1;
    server = http.createServer();
    io = initRealtimeServer(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    mongoose.connection.readyState = 0;
    await new Promise((resolve) => io.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });

  afterEach(() => {
    while (clients.length) clients.pop().disconnect();
  });

  async function joinedClient(token, roomId) {
    const client = connect(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth: { token },
    });
    clients.push(client);
    await nextEvent(client, 'connect');
    const ack = await emitAck(client, 'room:join', { roomId });
    expect(ack.ok).toBe(true);
    return { client, ack };
  }

  test('joining by database _id returns and uses the canonical roomId', async () => {
    const { client: alice, ack } = await joinedClient(tokenAlice, ROOM_OBJECT_ID);

    expect(ack.roomId).toBe(room.roomId);
    expect(getDriver(room.roomId)).toBe(alice.id);
    expect(getDriver(ROOM_OBJECT_ID)).toBeNull();
  });

  test('a Viewer joining through the _id alias cannot become a second Driver', async () => {
    const { client: alice } = await joinedClient(tokenAlice, room.roomId);
    const { client: bob, ack: bobAck } = await joinedClient(tokenBob, ROOM_OBJECT_ID);

    expect(bobAck.roomId).toBe(room.roomId);
    expect(getDriver(room.roomId)).toBe(alice.id);
    expect(getDriver(ROOM_OBJECT_ID)).toBeNull();

    const aliasEdit = await emitAck(bob, 'editor:change', {
      roomId: ROOM_OBJECT_ID,
      code: 'print(1)',
      language: 'python',
    });
    expect(aliasEdit.ok).toBe(false);

    const canonicalEdit = await emitAck(bob, 'editor:change', {
      roomId: room.roomId,
      code: 'print(1)',
      language: 'python',
    });
    expect(canonicalEdit).toEqual({ ok: false, error: 'Only the active driver can edit code' });
  });

  test('both members receive room updates in the same socket room', async () => {
    const { client: alice } = await joinedClient(tokenAlice, room.roomId);
    const joined = nextEvent(alice, 'room:user_joined');
    await joinedClient(tokenBob, ROOM_OBJECT_ID);

    const payload = await joined;
    expect(payload.user.id).toBe(userBob.id);
  });
});
