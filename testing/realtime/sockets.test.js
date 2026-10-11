const http = require('http');
const mongoose = require('mongoose');
const { io: connect } = require('socket.io-client');
const { initRealtimeServer } = require('../../realtime/server');
const Room = require('../../database/models/Room');
const { generateToken } = require('../../backend/src/middleware/auth');

const nextEvent = (socket, event) => new Promise((resolve, reject) => {
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

const emitAck = (socket, event, payload) => new Promise((resolve, reject) => {
  socket.timeout(2000).emit(event, payload, (error, response) => {
    if (error) reject(error);
    else resolve(response);
  });
});

describe('Room membership protocol', () => {
  let io;
  let clients;

  const userFirst = {
    userId: 'user-first-id',
    id: 'user-first-id',
    username: 'Same name',
    name: 'Same name',
    email: 'first@example.com',
  };

  const userSecond = {
    userId: 'user-second-id',
    id: 'user-second-id',
    username: 'Same name',
    name: 'Same name',
    email: 'second@example.com',
  };

  const tokenFirst = generateToken(userFirst);
  const tokenSecond = generateToken(userSecond);

  beforeEach(async () => {
    mongoose.connection.readyState = 1;
    jest.spyOn(Room, 'findOne').mockImplementation((query) => {
      const targetRoomId = query.roomId || (query.$or && query.$or[0]?.roomId) || 'shared-room';
      return Promise.resolve({
        roomId: targetRoomId,
        owner: userFirst.userId,
        members: [userFirst.userId, userSecond.userId],
      });
    });

    const server = http.createServer();
    io = initRealtimeServer(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    clients = [0, 1].map(() => connect(`http://127.0.0.1:${server.address().port}`, {
      autoConnect: false,
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    }));
    await Promise.all(clients.map(async (client) => {
      const connected = nextEvent(client, 'connect');
      client.connect();
      await connected;
    }));
  });

  afterEach(async () => {
    clients.forEach((client) => client.disconnect());
    await new Promise((resolve) => io.close(resolve));
    if (Room.findOne.mockRestore) {
      Room.findOne.mockRestore();
    }
    mongoose.connection.readyState = 0;
  });

  test.each(['leave', 'disconnect'])('snapshots existing members and notifies peers on %s', async (departure) => {
    const [first, second] = clients;
    const roomId = 'shared-room';

    const effectiveFirst = {
      _id: userFirst.userId,
      id: userFirst.userId,
      userId: userFirst.userId,
      username: userFirst.username,
      name: userFirst.name,
      email: userFirst.email,
    };
    const effectiveSecond = {
      _id: userSecond.userId,
      id: userSecond.userId,
      userId: userSecond.userId,
      username: userSecond.username,
      name: userSecond.name,
      email: userSecond.email,
    };

    const firstMember = { socketId: first.id, user: effectiveFirst };
    const secondMember = { socketId: second.id, user: effectiveSecond };
    const firstSnapshot = nextEvent(first, 'room:members');
    expect(await emitAck(first, 'room:join', { roomId, token: tokenFirst })).toEqual({
      ok: true, roomId, socketId: first.id,
    });
    expect(await firstSnapshot).toEqual({ roomId, members: [firstMember] });

    const unexpectedSnapshot = jest.fn();
    first.on('room:members', unexpectedSnapshot);
    const joined = nextEvent(first, 'room:user_joined');
    const secondSnapshot = nextEvent(second, 'room:members');
    expect(await emitAck(second, 'room:join', { roomId, token: tokenSecond })).toEqual({
      ok: true, roomId, socketId: second.id,
    });
    expect(await secondSnapshot).toEqual({ roomId, members: [firstMember, secondMember] });
    expect(await joined).toEqual(secondMember);

    const left = nextEvent(first, 'room:user_left');
    if (departure === 'leave') {
      expect(await emitAck(second, 'room:leave', { roomId })).toEqual({
        ok: true, roomId, socketId: second.id,
      });
    } else {
      second.disconnect();
    }
    expect(await left).toEqual(secondMember);
    expect(unexpectedSnapshot).not.toHaveBeenCalled();

    const refreshed = nextEvent(first, 'room:members');
    await emitAck(first, 'room:join', { roomId, token: tokenFirst });
    expect(await refreshed).toEqual({ roomId, members: [firstMember] });

    if (departure === 'leave') {
      await emitAck(first, 'room:leave', { roomId });
      expect(io.sockets.adapter.rooms.has(roomId)).toBe(false);
    }
  });

  test('isolates snapshots by room and rejects an invalid join', async () => {
    const [first, second] = clients;
    await emitAck(first, 'room:join', { roomId: 'other-room', token: tokenFirst });
    expect(await emitAck(second, 'room:join', { roomId: '' })).toEqual({
      ok: false, error: 'roomId is required',
    });
    const snapshot = nextEvent(second, 'room:members');
    await emitAck(second, 'room:join', { roomId: 'shared-room', token: tokenSecond });
    const effectiveSecond = {
      _id: userSecond.userId,
      id: userSecond.userId,
      userId: userSecond.userId,
      username: userSecond.username,
      name: userSecond.name,
      email: userSecond.email,
    };
    expect(await snapshot).toEqual({
      roomId: 'shared-room', members: [{ socketId: second.id, user: effectiveSecond }],
    });
  });
});

