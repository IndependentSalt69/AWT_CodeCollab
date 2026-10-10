const http = require('http');
const mongoose = require('mongoose');
const { io: connect } = require('socket.io-client');
const { initRealtimeServer } = require('../../realtime/server');
const Room = require('../../database/models/Room');
const { generateToken } = require('../../backend/src/middleware/auth');

const SOCKET_EVENTS = {
  ROOM: {
    JOIN: 'room:join',
    LEAVE: 'room:leave',
    MEMBERS: 'room:members',
    USER_JOINED: 'room:user_joined',
    USER_LEFT: 'room:user_left',
  },
};

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

describe('M0.3b — Presence Activity Feed verification', () => {
  let io;
  let server;
  let clients;

  const userAlice = {
    userId: 'user-alice-id',
    id: 'user-alice-id',
    username: 'Alice',
    name: 'Alice',
    email: 'alice@example.com',
  };

  const userBob = {
    userId: 'user-bob-id',
    id: 'user-bob-id',
    username: 'Bob',
    name: 'Bob',
    email: 'bob@example.com',
  };

  const userCharlie = {
    userId: 'user-charlie-id',
    id: 'user-charlie-id',
    username: 'Charlie',
    name: 'Charlie',
    email: 'charlie@example.com',
  };

  const tokenAlice = generateToken(userAlice);
  const tokenBob = generateToken(userBob);
  const tokenCharlie = generateToken(userCharlie);

  beforeEach(async () => {
    mongoose.connection.readyState = 1;
    jest.spyOn(Room, 'findOne').mockImplementation((query) => {
      const targetRoomId = query.roomId || (query.$or && query.$or[0]?.roomId) || 'activity-feed-room';
      return Promise.resolve({
        roomId: targetRoomId,
        owner: userAlice.userId,
        members: [userAlice.userId, userBob.userId, userCharlie.userId],
      });
    });

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
    if (Room.findOne.mockRestore) {
      Room.findOne.mockRestore();
    }
    mongoose.connection.readyState = 0;
  });

  test('generates expected join and leave activity events without echoing to self', async () => {
    const [client1, client2, client3] = clients;
    const roomId = 'activity-feed-room';

    const client1Activity = [];
    const client2Activity = [];

    const handleJoinActivity = (feed, clientSocket) => (payload) => {
      if (payload.socketId !== clientSocket.id) {
        const name = payload.user?.name || payload.socketId;
        feed.push(`🟢 ${name} joined the room`);
      }
    };

    const handleLeaveActivity = (feed, clientSocket) => (payload) => {
      if (payload.socketId !== clientSocket.id) {
        const name = payload.user?.name || payload.socketId;
        feed.push(`🔴 ${name} left the room`);
      }
    };

    client1.on(SOCKET_EVENTS.ROOM.USER_JOINED, handleJoinActivity(client1Activity, client1));
    client1.on(SOCKET_EVENTS.ROOM.USER_LEFT, handleLeaveActivity(client1Activity, client1));

    client2.on(SOCKET_EVENTS.ROOM.USER_JOINED, handleJoinActivity(client2Activity, client2));
    client2.on(SOCKET_EVENTS.ROOM.USER_LEFT, handleLeaveActivity(client2Activity, client2));

    // 1. Client 1 joins room
    await emitAck(client1, SOCKET_EVENTS.ROOM.JOIN, { roomId, token: tokenAlice });
    expect(client1Activity).toHaveLength(0);

    // 2. Client 2 joins room
    const user2JoinedPromise = nextEvent(client1, SOCKET_EVENTS.ROOM.USER_JOINED);
    await emitAck(client2, SOCKET_EVENTS.ROOM.JOIN, { roomId, token: tokenBob });
    await user2JoinedPromise;

    expect(client1Activity).toEqual(['🟢 Bob joined the room']);
    expect(client2Activity).toHaveLength(0);

    // 3. Client 3 joins room
    const user3OnClient1 = nextEvent(client1, SOCKET_EVENTS.ROOM.USER_JOINED);
    const user3OnClient2 = nextEvent(client2, SOCKET_EVENTS.ROOM.USER_JOINED);
    await emitAck(client3, SOCKET_EVENTS.ROOM.JOIN, { roomId, token: tokenCharlie });
    await Promise.all([user3OnClient1, user3OnClient2]);

    expect(client1Activity).toEqual([
      '🟢 Bob joined the room',
      '🟢 Charlie joined the room',
    ]);
    expect(client2Activity).toEqual([
      '🟢 Charlie joined the room',
    ]);

    // 4. Client 2 (Bob) leaves room
    const bobLeftOnClient1 = nextEvent(client1, SOCKET_EVENTS.ROOM.USER_LEFT);
    await emitAck(client2, SOCKET_EVENTS.ROOM.LEAVE, { roomId });
    await bobLeftOnClient1;

    expect(client1Activity).toEqual([
      '🟢 Bob joined the room',
      '🟢 Charlie joined the room',
      '🔴 Bob left the room',
    ]);

    // 5. Client 3 (Charlie) disconnects
    const charlieLeftOnClient1 = nextEvent(client1, SOCKET_EVENTS.ROOM.USER_LEFT);
    client3.disconnect();
    await charlieLeftOnClient1;

    expect(client1Activity).toEqual([
      '🟢 Bob joined the room',
      '🟢 Charlie joined the room',
      '🔴 Bob left the room',
      '🔴 Charlie left the room',
    ]);
  });
});

