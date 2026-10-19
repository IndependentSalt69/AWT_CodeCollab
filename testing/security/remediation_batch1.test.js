const http = require('http');
const { io: connect } = require('socket.io-client');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { initRealtimeServer } = require('../../realtime/server');
const Room = require('../../database/models/Room');
const Message = require('../../database/models/Message');
const { verifyDriverPermission } = require('../../backend/src/services/executionService');

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const generateToken = (user) =>
  jwt.sign(
    {
      id: user.id || user._id,
      userId: user.id || user._id,
      username: user.username,
      email: user.email || `${user.username}@example.com`,
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

const nextEvent = (socket, event, timeoutMs = 2000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const handler = (payload) => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(event, handler);
  });

const emitAck = (socket, event, payload, timeoutMs = 2000) =>
  new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit(event, payload, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });

describe('Security Remediation Batch 1 Regression Suite', () => {
  let server;
  let io;
  let port;
  const mockRoomsDb = new Map();

  const userAlice = {
    id: '67056a1b2c3d4e5f6a7b8c01',
    _id: '67056a1b2c3d4e5f6a7b8c01',
    username: 'alice',
    email: 'alice@example.com',
  };

  const userBob = {
    id: '67056a1b2c3d4e5f6a7b8c02',
    _id: '67056a1b2c3d4e5f6a7b8c02',
    username: 'bob',
    email: 'bob@example.com',
  };

  const userEve = {
    id: '67056a1b2c3d4e5f6a7b8c99',
    _id: '67056a1b2c3d4e5f6a7b8c99',
    username: 'eve',
    email: 'eve@example.com',
  };

  const tokenAlice = generateToken(userAlice);
  const tokenBob = generateToken(userBob);
  const tokenEve = generateToken(userEve);

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;

    // Database boundary mock
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

    jest.spyOn(Message, 'create').mockImplementation(async (doc) => ({
      _id: new mongoose.Types.ObjectId(),
      ...doc,
      createdAt: new Date(),
    }));

    mongoose.connection.readyState = 1;
    server = http.createServer();
    io = initRealtimeServer(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    mongoose.connection.readyState = 0;
    if (Room.findOne.mockRestore) {
      Room.findOne.mockRestore();
    }
    Message.create.mockRestore();
    await new Promise((resolve) => io.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    mockRoomsDb.clear();
    mongoose.connection.readyState = 1;
  });

  const createClient = (token = null) => {
    const auth = token ? { token } : {};
    return connect(`http://127.0.0.1:${port}`, {
      autoConnect: false,
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth,
    });
  };

  // -------------------------------------------------------------
  // SEC-ROOM-01: Room Authorization & Fail-Closed Checks
  // -------------------------------------------------------------
  describe('SEC-ROOM-01: Room join authorization & fail-closed security', () => {
    test('unauthenticated join is rejected before joining room', async () => {
      const client = createClient();
      client.connect();
      await nextEvent(client, 'connect');

      const roomId = 'secure-room-1';
      mockRoomsDb.set(roomId, {
        roomId,
        name: 'Secure Room 1',
        owner: userAlice.id,
        members: [userAlice.id],
      });

      const ack = await emitAck(client, 'room:join', { roomId });
      expect(ack.ok).toBe(false);
      expect(ack.error).toMatch(/Authentication required/i);

      // Verify socket did not join room
      expect(io.sockets.adapter.rooms.has(roomId)).toBe(false);
      client.disconnect();
    });

    test('unknown room is rejected and socket does not join room', async () => {
      const client = createClient(tokenAlice);
      client.connect();
      await nextEvent(client, 'connect');

      const ack = await emitAck(client, 'room:join', {
        roomId: 'non-existent-room-xyz',
        token: tokenAlice,
      });

      expect(ack.ok).toBe(false);
      expect(ack.error).toMatch(/Room not found/i);
      expect(io.sockets.adapter.rooms.has('non-existent-room-xyz')).toBe(false);
      client.disconnect();
    });

    test('non-member cannot join private room', async () => {
      const roomId = 'private-room-1';
      mockRoomsDb.set(roomId, {
        roomId,
        name: 'Private Room',
        owner: userAlice.id,
        members: [userAlice.id],
      });

      const eveClient = createClient(tokenEve);
      eveClient.connect();
      await nextEvent(eveClient, 'connect');

      const ack = await emitAck(eveClient, 'room:join', {
        roomId,
        token: tokenEve,
      });

      expect(ack.ok).toBe(false);
      expect(ack.error).toMatch(/Access denied.*not a member/i);
      expect(io.sockets.adapter.rooms.has(roomId)).toBe(false);
      eveClient.disconnect();
    });

    test('disconnected / unavailable database fails closed', async () => {
      const roomId = 'db-down-room';
      mockRoomsDb.set(roomId, {
        roomId,
        name: 'DB Room',
        owner: userAlice.id,
        members: [userAlice.id],
      });

      mongoose.connection.readyState = 0; // Simulate DB disconnected

      const client = createClient(tokenAlice);
      client.connect();
      await nextEvent(client, 'connect');

      const ack = await emitAck(client, 'room:join', {
        roomId,
        token: tokenAlice,
      });

      expect(ack.ok).toBe(false);
      expect(ack.error).toMatch(/service unavailable|Database connection error/i);
      expect(io.sockets.adapter.rooms.has(roomId)).toBe(false);

      client.disconnect();
      mongoose.connection.readyState = 1;
    });

    test('database lookup exception fails closed', async () => {
      const roomId = 'db-error-room';
      Room.findOne.mockRejectedValueOnce(new Error('MongoNetworkTimeoutException'));

      const client = createClient(tokenAlice);
      client.connect();
      await nextEvent(client, 'connect');

      const ack = await emitAck(client, 'room:join', {
        roomId,
        token: tokenAlice,
      });

      expect(ack.ok).toBe(false);
      expect(ack.error).toMatch(/Database error occurred/i);
      expect(io.sockets.adapter.rooms.has(roomId)).toBe(false);
      client.disconnect();
    });

    test('runtime rooms.js does not check Room.findOne.mock', () => {
      const fs = require('fs');
      const path = require('path');
      const roomsSource = fs.readFileSync(path.resolve(__dirname, '../../realtime/server/rooms.js'), 'utf8');
      expect(roomsSource).not.toMatch(/\.mock\b/);
      expect(roomsSource).not.toMatch(/isDbConfigured/);
    });
  });

  // -------------------------------------------------------------
  // SEC-CHAT-01: Chat Authorization & Spoofing Prevention
  // -------------------------------------------------------------
  describe('SEC-CHAT-01: Chat authorization & spoofing prevention', () => {
    test('non-member socket cannot broadcast chat to a room', async () => {
      const roomId = 'chat-secure-room';
      mockRoomsDb.set(roomId, {
        roomId,
        name: 'Chat Room',
        owner: userAlice.id,
        members: [userAlice.id],
      });

      // Alice joins
      const aliceClient = createClient(tokenAlice);
      aliceClient.connect();
      await nextEvent(aliceClient, 'connect');
      await emitAck(aliceClient, 'room:join', { roomId, token: tokenAlice });

      // Eve connects but does not join
      const eveClient = createClient(tokenEve);
      eveClient.connect();
      await nextEvent(eveClient, 'connect');

      const aliceMessageSpy = jest.fn();
      aliceClient.on('chat:message_received', aliceMessageSpy);

      const ack = await emitAck(eveClient, 'chat:message_send', {
        roomId,
        message: 'Malicious non-member message',
      });

      expect(ack.ok).toBe(false);
      expect(ack.error).toMatch(/not a member of the room/i);

      await new Promise((r) => setTimeout(r, 50));
      expect(aliceMessageSpy).not.toHaveBeenCalled();

      aliceClient.disconnect();
      eveClient.disconnect();
    });

    test('unauthenticated socket cannot broadcast chat', async () => {
      const unauthClient = createClient();
      unauthClient.connect();
      await nextEvent(unauthClient, 'connect');

      const ack = await emitAck(unauthClient, 'chat:message_send', {
        roomId: 'any-room',
        message: 'Hello unauth',
      });

      expect(ack.ok).toBe(false);
      expect(ack.error).toMatch(/not a member of the room/i);
      unauthClient.disconnect();
    });

    test('sender cannot impersonate another user; server enforces verified identity', async () => {
      const roomId = 'chat-spoof-prevention';
      mockRoomsDb.set(roomId, {
        roomId,
        name: 'Spoof Test Room',
        owner: userAlice.id,
        members: [userAlice.id, userBob.id],
      });

      const aliceClient = createClient(tokenAlice);
      const bobClient = createClient(tokenBob);

      aliceClient.connect();
      bobClient.connect();
      await Promise.all([nextEvent(aliceClient, 'connect'), nextEvent(bobClient, 'connect')]);

      await emitAck(aliceClient, 'room:join', { roomId, token: tokenAlice });
      await emitAck(bobClient, 'room:join', { roomId, token: tokenBob });

      const aliceMsgPromise = nextEvent(aliceClient, 'chat:message_received');

      // Bob attempts to spoof identity as Alice/Admin
      const spoofPayload = {
        roomId,
        message: 'I am Alice',
        user: {
          id: userAlice.id,
          username: 'alice',
          name: 'SuperAdmin',
          role: 'admin',
        },
      };

      const ack = await emitAck(bobClient, 'chat:message_send', spoofPayload);
      expect(ack.ok).toBe(true);

      const receivedMsg = await aliceMsgPromise;
      // Received message user MUST be Bob's server-verified identity, NOT Alice
      expect(receivedMsg.user.id).toBe(userBob.id);
      expect(receivedMsg.user.username).toBe(userBob.username);
      expect(receivedMsg.user.name).not.toBe('SuperAdmin');

      aliceClient.disconnect();
      bobClient.disconnect();
    });

    test('rejects oversized chat messages', async () => {
      const roomId = 'chat-length-room';
      mockRoomsDb.set(roomId, {
        roomId,
        name: 'Length Test Room',
        owner: userAlice.id,
        members: [userAlice.id],
      });

      const aliceClient = createClient(tokenAlice);
      aliceClient.connect();
      await nextEvent(aliceClient, 'connect');
      await emitAck(aliceClient, 'room:join', { roomId, token: tokenAlice });

      const hugeMessage = 'A'.repeat(2001);
      const ack = await emitAck(aliceClient, 'chat:message_send', {
        roomId,
        message: hugeMessage,
      });

      expect(ack.ok).toBe(false);
      expect(ack.error).toMatch(/Message exceeds maximum allowed length/i);

      aliceClient.disconnect();
    });
  });

  // -------------------------------------------------------------
  // SEC-REALTIME-02: Presence & Typing Authorization
  // -------------------------------------------------------------
  describe('SEC-REALTIME-02: Presence & typing authorization & spoofing prevention', () => {
    test('unjoined socket cannot emit presence:status or presence:ping into a room', async () => {
      const roomId = 'presence-secure-room';
      mockRoomsDb.set(roomId, {
        roomId,
        name: 'Presence Room',
        owner: userAlice.id,
        members: [userAlice.id],
      });

      const aliceClient = createClient(tokenAlice);
      aliceClient.connect();
      await nextEvent(aliceClient, 'connect');
      await emitAck(aliceClient, 'room:join', { roomId, token: tokenAlice });

      const alicePresenceSpy = jest.fn();
      aliceClient.on('presence:status_update', alicePresenceSpy);

      // Eve is not in room
      const eveClient = createClient(tokenEve);
      eveClient.connect();
      await nextEvent(eveClient, 'connect');

      const ack = await emitAck(eveClient, 'presence:status', {
        roomId,
        status: 'away',
      });

      expect(ack.ok).toBe(false);
      expect(ack.error).toMatch(/not a member of the room/i);

      await new Promise((r) => setTimeout(r, 50));
      expect(alicePresenceSpy).not.toHaveBeenCalled();

      aliceClient.disconnect();
      eveClient.disconnect();
    });

    test('unjoined socket cannot emit typing:start or typing:stop into a room', async () => {
      const roomId = 'typing-secure-room';
      mockRoomsDb.set(roomId, {
        roomId,
        name: 'Typing Room',
        owner: userAlice.id,
        members: [userAlice.id],
      });

      const aliceClient = createClient(tokenAlice);
      aliceClient.connect();
      await nextEvent(aliceClient, 'connect');
      await emitAck(aliceClient, 'room:join', { roomId, token: tokenAlice });

      const aliceTypingSpy = jest.fn();
      aliceClient.on('typing:user_typing', aliceTypingSpy);

      const eveClient = createClient(tokenEve);
      eveClient.connect();
      await nextEvent(eveClient, 'connect');

      const ack = await emitAck(eveClient, 'typing:start', { roomId });
      expect(ack.ok).toBe(false);
      expect(ack.error).toMatch(/not a member of the room/i);

      await new Promise((r) => setTimeout(r, 50));
      expect(aliceTypingSpy).not.toHaveBeenCalled();

      aliceClient.disconnect();
      eveClient.disconnect();
    });

    test('presence and typing broadcasts use server-verified identity, ignoring client spoofing', async () => {
      const roomId = 'presence-spoof-prevention';
      mockRoomsDb.set(roomId, {
        roomId,
        name: 'Presence Spoof Room',
        owner: userAlice.id,
        members: [userAlice.id, userBob.id],
      });

      const aliceClient = createClient(tokenAlice);
      const bobClient = createClient(tokenBob);

      aliceClient.connect();
      bobClient.connect();
      await Promise.all([nextEvent(aliceClient, 'connect'), nextEvent(bobClient, 'connect')]);

      await emitAck(aliceClient, 'room:join', { roomId, token: tokenAlice });
      await emitAck(bobClient, 'room:join', { roomId, token: tokenBob });

      const aliceTypingPromise = nextEvent(aliceClient, 'typing:user_typing');

      // Bob tries to spoof typing user as Alice
      const spoofTypingPayload = {
        roomId,
        user: {
          id: userAlice.id,
          username: 'alice',
        },
      };

      const ack = await emitAck(bobClient, 'typing:start', spoofTypingPayload);
      expect(ack.ok).toBe(true);

      const typingEvent = await aliceTypingPromise;
      expect(typingEvent.user.id).toBe(userBob.id);
      expect(typingEvent.user.username).toBe(userBob.username);

      aliceClient.disconnect();
      bobClient.disconnect();
    });
  });

  // -------------------------------------------------------------
  // SEC-AUTH-03: Driver Execution ID Enforcement
  // -------------------------------------------------------------
  describe('SEC-AUTH-03: Driver permission verification strictly requires matching user IDs', () => {
    test('same username with different user ID is rejected from Driver execution', async () => {
      const roomId = 'driver-id-check-room';
      mockRoomsDb.set(roomId, {
        roomId,
        name: 'Driver Check Room',
        owner: userAlice.id,
        members: [userAlice.id],
      });

      // Alice joins and becomes driver
      const aliceClient = createClient(tokenAlice);
      aliceClient.connect();
      await nextEvent(aliceClient, 'connect');
      await emitAck(aliceClient, 'room:join', { roomId, token: tokenAlice });

      // Attacker creates a token with username "alice", but with a different user ID (impersonation attempt)
      const attackerWithSameUsername = {
        id: '67056a1b2c3d4e5f6a7b8c99',
        _id: '67056a1b2c3d4e5f6a7b8c99',
        username: 'alice', // Same username!
        email: 'attacker@example.com',
      };

      // Call verifyDriverPermission directly with the spoofed user and Alice's driver socket
      const authResult = await verifyDriverPermission({
        roomId,
        user: attackerWithSameUsername,
        socketId: aliceClient.id,
        io,
      });

      expect(authResult.authorized).toBe(false);
      expect(authResult.status).toBe(403);
      expect(authResult.error).toMatch(/does not match the active room driver session/i);

      aliceClient.disconnect();
    });

    test('valid driver with matching user ID is authorized', async () => {
      const roomId = 'valid-driver-room';
      mockRoomsDb.set(roomId, {
        roomId,
        name: 'Valid Driver Room',
        owner: userAlice.id,
        members: [userAlice.id],
      });

      const aliceClient = createClient(tokenAlice);
      aliceClient.connect();
      await nextEvent(aliceClient, 'connect');
      await emitAck(aliceClient, 'room:join', { roomId, token: tokenAlice });

      const authResult = await verifyDriverPermission({
        roomId,
        user: userAlice,
        socketId: aliceClient.id,
        io,
      });

      expect(authResult.authorized).toBe(true);

      aliceClient.disconnect();
    });

    test('viewer socket is rejected from Driver execution', async () => {
      const roomId = 'viewer-driver-check-room';
      mockRoomsDb.set(roomId, {
        roomId,
        name: 'Viewer Check Room',
        owner: userAlice.id,
        members: [userAlice.id, userBob.id],
      });

      const aliceClient = createClient(tokenAlice);
      const bobClient = createClient(tokenBob);

      aliceClient.connect();
      bobClient.connect();
      await Promise.all([nextEvent(aliceClient, 'connect'), nextEvent(bobClient, 'connect')]);

      await emitAck(aliceClient, 'room:join', { roomId, token: tokenAlice }); // Alice is driver
      await emitAck(bobClient, 'room:join', { roomId, token: tokenBob });     // Bob is viewer

      const authResult = await verifyDriverPermission({
        roomId,
        user: userBob,
        socketId: bobClient.id,
        io,
      });

      expect(authResult.authorized).toBe(false);
      expect(authResult.status).toBe(403);
      expect(authResult.error).toMatch(/only the active room driver/i);

      aliceClient.disconnect();
      bobClient.disconnect();
    });
  });
});
