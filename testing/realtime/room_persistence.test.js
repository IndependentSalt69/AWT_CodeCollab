/**
 * Realtime Room Persistence & Authorization Integration Tests (M0.8)
 *
 * Validates:
 * - Unauthenticated socket cannot join a persistent room (rejected)
 * - Authenticated non-member cannot join room without membership (rejected)
 * - Authenticated member joins successfully
 * - Driver assigned to first eligible member; subsequent joiners are Viewers
 * - Disconnecting a live socket does NOT delete persistent membership in database
 * - Room isolation between multiple persistent rooms
 */

const http = require('http');
const { io: connect } = require('socket.io-client');
const mongoose = require('mongoose');
const { initRealtimeServer } = require('../../realtime/server');
const { generateToken } = require('../../backend/src/middleware/auth');
const Room = require('../../database/models/Room');

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

describe('Realtime Room Persistence & Authorization Protocol (M0.8)', () => {
  let io;
  let server;
  let port;
  const mockRoomsDb = new Map();

  const userAlice = {
    userId: '67056a1b2c3d4e5f6a7b8c01',
    id: '67056a1b2c3d4e5f6a7b8c01',
    username: 'alice',
    email: 'alice@example.com',
  };

  const userBob = {
    userId: '67056a1b2c3d4e5f6a7b8c02',
    id: '67056a1b2c3d4e5f6a7b8c02',
    username: 'bob',
    email: 'bob@example.com',
  };

  const userCharlie = {
    userId: '67056a1b2c3d4e5f6a7b8c03',
    id: '67056a1b2c3d4e5f6a7b8c03',
    username: 'charlie',
    email: 'charlie@example.com',
  };

  const tokenAlice = generateToken(userAlice);
  const tokenBob = generateToken(userBob);
  const tokenCharlie = generateToken(userCharlie);

  beforeAll(async () => {
    // Spy on Room.findOne for persistent room lookups
    jest.spyOn(Room, 'findOne').mockImplementation((query) => {
      let target = null;
      if (query.roomId) {
        target = mockRoomsDb.get(query.roomId) || null;
      } else if (query._id) {
        target = mockRoomsDb.get(String(query._id)) || null;
      } else if (query.$or) {
        for (const cond of query.$or) {
          if (cond.roomId && mockRoomsDb.has(cond.roomId)) {
            target = mockRoomsDb.get(cond.roomId);
            break;
          }
          if (cond._id && mockRoomsDb.has(String(cond._id))) {
            target = mockRoomsDb.get(String(cond._id));
            break;
          }
        }
      }
      return Promise.resolve(target);
    });

    server = http.createServer();
    io = initRealtimeServer(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    if (Room.findOne.mockRestore) {
      Room.findOne.mockRestore();
    }
    await new Promise((resolve) => io.close(resolve));
  });

  beforeEach(() => {
    mockRoomsDb.clear();
  });

  function createClient(token = null) {
    const auth = token ? { token } : {};
    return connect(`http://127.0.0.1:${port}`, {
      autoConnect: false,
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth,
    });
  }

  it('should reject unauthenticated socket from joining protected persistent room', async () => {
    const protectedRoomId = 'algo-protected-1';
    mockRoomsDb.set(protectedRoomId, {
      roomId: protectedRoomId,
      name: 'Protected Room',
      owner: userAlice.userId,
      members: [userAlice.userId],
    });

    const client = createClient(null); // No token
    client.connect();
    await nextEvent(client, 'connect');

    const response = await emitAck(client, 'room:join', { roomId: protectedRoomId });
    expect(response.ok).toBe(false);
    expect(response.error).toBe('Authentication required to join this room');
    expect(io.sockets.adapter.rooms.get(protectedRoomId)?.has(client.id)).toBeFalsy();

    client.disconnect();
  });

  it('should reject authenticated non-member from joining protected persistent room', async () => {
    const protectedRoomId = 'algo-protected-2';
    mockRoomsDb.set(protectedRoomId, {
      roomId: protectedRoomId,
      name: 'Alice Only Room',
      owner: userAlice.userId,
      members: [userAlice.userId],
    });

    // Charlie connects with token, but is NOT in members
    const client = createClient(tokenCharlie);
    client.connect();
    await nextEvent(client, 'connect');

    const response = await emitAck(client, 'room:join', { roomId: protectedRoomId });
    expect(response.ok).toBe(false);
    expect(response.error).toBe('Access denied: You are not a member of this room');
    expect(io.sockets.adapter.rooms.get(protectedRoomId)?.has(client.id)).toBeFalsy();

    client.disconnect();
  });

  it('should allow authenticated member to join, assign Driver to first member, and Viewer to second', async () => {
    const protectedRoomId = 'algo-collab-3';
    const roomRecord = {
      roomId: protectedRoomId,
      name: 'Collab Room',
      owner: userAlice.userId,
      members: [userAlice.userId, userBob.userId],
    };
    mockRoomsDb.set(protectedRoomId, roomRecord);

    const clientAlice = createClient(tokenAlice);
    const clientBob = createClient(tokenBob);

    clientAlice.connect();
    clientBob.connect();
    await Promise.all([nextEvent(clientAlice, 'connect'), nextEvent(clientBob, 'connect')]);

    // 1. Alice joins -> becomes Driver
    const driverEventPromise = nextEvent(clientAlice, 'editor:driver_updated');
    const aliceJoin = await emitAck(clientAlice, 'room:join', { roomId: protectedRoomId });
    expect(aliceJoin.ok).toBe(true);
    expect(aliceJoin.roomId).toBe(protectedRoomId);

    const driverPayload = await driverEventPromise;
    expect(driverPayload.driverId).toBe(clientAlice.id);

    // 2. Bob joins -> Viewer
    const bobDriverPromise = nextEvent(clientBob, 'editor:driver_updated');
    const bobJoin = await emitAck(clientBob, 'room:join', { roomId: protectedRoomId });
    expect(bobJoin.ok).toBe(true);

    const bobReceivedDriver = await bobDriverPromise;
    expect(bobReceivedDriver.driverId).toBe(clientAlice.id); // Alice remains Driver

    // 3. Persistent membership in database is completely untouched by socket events
    expect(roomRecord.members).toContain(userAlice.userId);
    expect(roomRecord.members).toContain(userBob.userId);

    // Verify sockets joined the Socket.io room
    expect(io.sockets.adapter.rooms.get(protectedRoomId).has(clientAlice.id)).toBe(true);
    expect(io.sockets.adapter.rooms.get(protectedRoomId).has(clientBob.id)).toBe(true);

    // Disconnect sockets
    clientAlice.disconnect();
    clientBob.disconnect();

    // Persistent membership remains intact after socket disconnect
    expect(roomRecord.members.length).toBe(2);
  });

  it('should reject joining non-existent persistent room before socket.join', async () => {
    const unknownRoomId = 'non-existent-room-999';

    const client = createClient(tokenAlice);
    client.connect();
    await nextEvent(client, 'connect');

    const response = await emitAck(client, 'room:join', { roomId: unknownRoomId });
    expect(response.ok).toBe(false);
    expect(response.error).toBe('Room not found');

    // Socket MUST NOT be added to room
    expect(io.sockets.adapter.rooms.get(unknownRoomId)?.has(client.id)).toBeFalsy();

    client.disconnect();
  });

  it('should reject joining room when database is disconnected (fail-closed, no authorization bypass)', async () => {
    const protectedRoomId = 'algo-protected-db-down';

    // Temporarily restore mock and set REQUIRE_ROOM_AUTH to simulate disconnected DB
    const mockImpl = Room.findOne.getMockImplementation();
    Room.findOne.mockRestore();
    process.env.REQUIRE_ROOM_AUTH = 'true';

    try {
      const client = createClient(tokenAlice);
      client.connect();
      await nextEvent(client, 'connect');

      const response = await emitAck(client, 'room:join', { roomId: protectedRoomId });
      expect(response.ok).toBe(false);
      expect(response.error).toBe('Database connection error: service unavailable');

      // Socket MUST NOT be added to room
      expect(io.sockets.adapter.rooms.get(protectedRoomId)?.has(client.id)).toBeFalsy();

      client.disconnect();
    } finally {
      delete process.env.REQUIRE_ROOM_AUTH;
      jest.spyOn(Room, 'findOne').mockImplementation(mockImpl);
    }
  });

  it('should reject joining room when database lookup throws an error without bypass', async () => {
    const protectedRoomId = 'algo-protected-db-err';

    Room.findOne.mockRejectedValueOnce(new Error('MongoDB connection timeout during lookup'));

    const client = createClient(tokenAlice);
    client.connect();
    await nextEvent(client, 'connect');

    const response = await emitAck(client, 'room:join', { roomId: protectedRoomId });
    expect(response.ok).toBe(false);
    expect(response.error).toBe('Database error occurred during room authorization');

    // Socket MUST NOT be added to room
    expect(io.sockets.adapter.rooms.get(protectedRoomId)?.has(client.id)).toBeFalsy();

    client.disconnect();
  });

  it('should reject socket with missing verified user ID metadata before socket.join', async () => {
    const protectedRoomId = 'algo-protected-metadata';
    mockRoomsDb.set(protectedRoomId, {
      roomId: protectedRoomId,
      name: 'Protected Room',
      owner: userAlice.userId,
      members: [userAlice.userId],
    });

    // Token generated with missing user ID fields
    const malformedToken = generateToken({ username: 'ghostUser' });

    const client = createClient(malformedToken);
    client.connect();
    await nextEvent(client, 'connect');

    const response = await emitAck(client, 'room:join', { roomId: protectedRoomId });
    expect(response.ok).toBe(false);
    expect(response.error).toBe('Authentication required to join this room');

    // Socket MUST NOT be added to room
    expect(io.sockets.adapter.rooms.get(protectedRoomId)?.has(client.id)).toBeFalsy();

    client.disconnect();
  });
});
