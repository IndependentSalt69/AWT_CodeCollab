/**
 * Realtime chat persistence tests
 *
 * Validates:
 * - chat:message_send persists the message with server-verified sender identity before broadcasting
 * - Persistence failures and a disconnected database reject the message without broadcasting
 * - Per-socket chat rate limiting
 */

const http = require('http');
const { io: connect } = require('socket.io-client');
const mongoose = require('mongoose');
const { initRealtimeServer } = require('../../realtime/server');
const Room = require('../../database/models/Room');
const Message = require('../../database/models/Message');
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

describe('Realtime chat persistence', () => {
  let server;
  let io;
  let port;
  const clients = [];

  const userAlice = { id: '67056a1b2c3d4e5f6a7b8c01', userId: '67056a1b2c3d4e5f6a7b8c01', username: 'alice', email: 'alice@example.com' };
  const userBob = { id: '67056a1b2c3d4e5f6a7b8c02', userId: '67056a1b2c3d4e5f6a7b8c02', username: 'bob', email: 'bob@example.com' };
  const tokenAlice = generateToken(userAlice);
  const tokenBob = generateToken(userBob);

  const ROOM_OBJECT_ID = '67056a1b2c3d4e5f6a7b8d00';
  const room = {
    _id: ROOM_OBJECT_ID,
    roomId: 'chat-room-a1b2c3',
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

  beforeEach(() => {
    mongoose.connection.readyState = 1;
    jest.spyOn(Message, 'create').mockImplementation(async (doc) => ({
      _id: new mongoose.Types.ObjectId(),
      ...doc,
      createdAt: new Date('2026-10-19T10:00:00.000Z'),
    }));
  });

  afterEach(() => {
    Message.create.mockRestore();
    while (clients.length) clients.pop().disconnect();
  });

  async function joinedClient(token, roomId = room.roomId) {
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

  test('persists the message with verified sender before broadcasting', async () => {
    const { client: alice } = await joinedClient(tokenAlice);
    const { client: bob } = await joinedClient(tokenBob);

    const received = nextEvent(alice, 'chat:message_received');
    const ack = await emitAck(bob, 'chat:message_send', {
      roomId: room.roomId,
      message: { text: '  hello team  ', sender: { id: userAlice.id, username: 'alice' } },
    });

    expect(ack.ok).toBe(true);
    expect(Message.create).toHaveBeenCalledWith({
      roomId: room.roomId,
      sender: userBob.id,
      senderUsername: 'bob',
      content: 'hello team',
    });

    const payload = await received;
    expect(payload.id).toEqual(expect.any(String));
    expect(payload.content).toBe('hello team');
    expect(payload.sender).toEqual({ id: userBob.id, userId: userBob.id, username: 'bob', name: 'bob' });
    expect(payload.sender.email).toBeUndefined();
    expect(payload.timestamp).toBe('2026-10-19T10:00:00.000Z');
  });

  test('does not broadcast when persistence fails', async () => {
    const { client: alice } = await joinedClient(tokenAlice);
    const spy = jest.fn();
    alice.on('chat:message_received', spy);

    Message.create.mockRejectedValueOnce(new Error('write concern timeout on mongo-1'));
    const ack = await emitAck(alice, 'chat:message_send', { roomId: room.roomId, message: 'hi' });

    expect(ack).toEqual({ ok: false, error: 'Failed to send message' });
    await new Promise((r) => setTimeout(r, 50));
    expect(spy).not.toHaveBeenCalled();
  });

  test('rejects messages while the database is disconnected', async () => {
    const { client: alice } = await joinedClient(tokenAlice);
    mongoose.connection.readyState = 0;

    const ack = await emitAck(alice, 'chat:message_send', { roomId: room.roomId, message: 'hi' });

    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/temporarily unavailable/i);
    expect(Message.create).not.toHaveBeenCalled();
  });

  test('rate limits a socket that sends too many messages', async () => {
    const { client: alice } = await joinedClient(tokenAlice);

    for (let i = 0; i < 10; i += 1) {
      const ack = await emitAck(alice, 'chat:message_send', { roomId: room.roomId, message: `msg ${i}` });
      expect(ack.ok).toBe(true);
    }

    const blocked = await emitAck(alice, 'chat:message_send', { roomId: room.roomId, message: 'one too many' });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/too quickly/i);
    expect(Message.create).toHaveBeenCalledTimes(10);
  });
});
