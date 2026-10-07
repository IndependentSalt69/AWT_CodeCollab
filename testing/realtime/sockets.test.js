const http = require('http');
const { io: connect } = require('socket.io-client');
const { initRealtimeServer } = require('../../realtime/server');

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

  beforeEach(async () => {
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
  });

  test.each(['leave', 'disconnect'])('snapshots existing members and notifies peers on %s', async (departure) => {
    const [first, second] = clients;
    const roomId = 'shared-room';
    // Identical names must remain distinct members by socket ID.
    const user = { name: 'Same name' };
    const firstMember = { socketId: first.id, user };
    const secondMember = { socketId: second.id, user };
    const firstSnapshot = nextEvent(first, 'room:members');
    expect(await emitAck(first, 'room:join', { roomId, user })).toEqual({
      ok: true, roomId, socketId: first.id,
    });
    expect(await firstSnapshot).toEqual({ roomId, members: [firstMember] });

    const unexpectedSnapshot = jest.fn();
    first.on('room:members', unexpectedSnapshot);
    const joined = nextEvent(first, 'room:user_joined');
    const secondSnapshot = nextEvent(second, 'room:members');
    expect(await emitAck(second, 'room:join', { roomId, user })).toEqual({
      ok: true, roomId, socketId: second.id,
    });
    expect(await secondSnapshot).toEqual({ roomId, members: [firstMember, secondMember] });
    expect(await joined).toEqual(secondMember);

    const left = nextEvent(first, 'room:user_left');
    if (departure === 'leave') {
      // The server uses the stored identity even if leave omits user.
      expect(await emitAck(second, 'room:leave', { roomId })).toEqual({
        ok: true, roomId, socketId: second.id,
      });
    } else {
      second.disconnect();
    }
    expect(await left).toEqual(secondMember);
    expect(unexpectedSnapshot).not.toHaveBeenCalled();

    const refreshed = nextEvent(first, 'room:members');
    await emitAck(first, 'room:join', { roomId, user });
    expect(await refreshed).toEqual({ roomId, members: [firstMember] });

    if (departure === 'leave') {
      await emitAck(first, 'room:leave', { roomId });
      expect(io.sockets.adapter.rooms.has(roomId)).toBe(false);
    }
  });

  test('isolates snapshots by room and rejects an invalid join', async () => {
    const [first, second] = clients;
    await emitAck(first, 'room:join', { roomId: 'other-room', user: { name: 'First' } });
    expect(await emitAck(second, 'room:join', { roomId: '' })).toEqual({
      ok: false, error: 'roomId is required',
    });
    const snapshot = nextEvent(second, 'room:members');
    const user = { name: 'Second' };
    await emitAck(second, 'room:join', { roomId: 'shared-room', user });
    expect(await snapshot).toEqual({
      roomId: 'shared-room', members: [{ socketId: second.id, user }],
    });
  });
});
