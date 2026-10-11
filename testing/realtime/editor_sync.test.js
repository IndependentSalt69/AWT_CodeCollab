const http = require('http');
const { io: connect } = require('socket.io-client');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Room = require('../../database/models/Room');
const { initRealtimeServer } = require('../../realtime/server');

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const generateToken = (userId, username) =>
  jwt.sign(
    { id: userId, username, email: `${username.toLowerCase().replace(/\s+/g, '')}@example.com` },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

const SOCKET_EVENTS = {
  ROOM: {
    JOIN: 'room:join',
    LEAVE: 'room:leave',
    MEMBERS: 'room:members',
    USER_JOINED: 'room:user_joined',
    USER_LEFT: 'room:user_left',
  },
  EDITOR: {
    CHANGE: 'editor:change',
    UPDATE: 'editor:update',
    DRIVER_CHANGE: 'editor:driver_change',
    DRIVER_UPDATED: 'editor:driver_updated',
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

describe('M0.4b — Server-side Editor Synchronization & Hardening', () => {
  let io;
  let server;
  let clients;

  beforeAll(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    mongoose.connection.readyState = 1;
  });

  beforeEach(async () => {
    Room.findOne = jest.fn().mockImplementation((query) => {
      const roomId = query?.roomId || (query?.$or && query.$or[0]?.roomId) || 'test-room';
      const doc = {
        roomId,
        name: roomId,
        owner: 'driver-id',
        members: [
          'driver-id',
          'viewer1-id',
          'viewer2-id',
          'viewer-id',
          'temp-id',
          'driverA-id',
          'viewerA-id',
          'driverB-id',
          'viewerB-id',
          'userA-id',
          'userB-id',
        ],
        isPublic: true,
      };
      return Promise.resolve(doc);
    });

    server = http.createServer();
    io = initRealtimeServer(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    clients = [0, 1, 2, 3].map(() =>
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

  test('driver can emit editor:change, peers receive editor:update, sender does not receive it', async () => {
    const [driver, viewer1, viewer2] = clients;
    const roomId = 'editor-sync-room';

    await emitAck(driver, SOCKET_EVENTS.ROOM.JOIN, { roomId, token: generateToken('driver-id', 'Driver'), user: { name: 'Driver' } });
    await emitAck(viewer1, SOCKET_EVENTS.ROOM.JOIN, { roomId, token: generateToken('viewer1-id', 'Viewer1'), user: { name: 'Viewer1' } });
    await emitAck(viewer2, SOCKET_EVENTS.ROOM.JOIN, { roomId, token: generateToken('viewer2-id', 'Viewer2'), user: { name: 'Viewer2' } });

    const selfUpdateSpy = jest.fn();
    driver.on(SOCKET_EVENTS.EDITOR.UPDATE, selfUpdateSpy);

    const viewer1UpdatePromise = nextEvent(viewer1, SOCKET_EVENTS.EDITOR.UPDATE);
    const viewer2UpdatePromise = nextEvent(viewer2, SOCKET_EVENTS.EDITOR.UPDATE);

    const changePayload = {
      roomId,
      code: 'function add(a, b) { return a + b; }',
      language: 'javascript',
    };

    const ack = await emitAck(driver, SOCKET_EVENTS.EDITOR.CHANGE, changePayload);
    expect(ack).toEqual({ ok: true });

    const update1 = await viewer1UpdatePromise;
    const update2 = await viewer2UpdatePromise;

    expect(update1).toEqual({
      code: 'function add(a, b) { return a + b; }',
      language: 'javascript',
      updatedBy: driver.id,
    });
    expect(update2).toEqual(update1);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(selfUpdateSpy).not.toHaveBeenCalled();
    driver.off(SOCKET_EVENTS.EDITOR.UPDATE, selfUpdateSpy);
  });

  test('viewer editor:change is rejected and not broadcast to room peers', async () => {
    const [driver, viewer] = clients;
    const roomId = 'viewer-rejection-room';

    await emitAck(driver, SOCKET_EVENTS.ROOM.JOIN, { roomId, token: generateToken('driver-id', 'Driver'), user: { name: 'Driver' } });
    await emitAck(viewer, SOCKET_EVENTS.ROOM.JOIN, { roomId, token: generateToken('viewer-id', 'Viewer'), user: { name: 'Viewer' } });

    const driverUpdateSpy = jest.fn();
    driver.on(SOCKET_EVENTS.EDITOR.UPDATE, driverUpdateSpy);

    const ack = await emitAck(viewer, SOCKET_EVENTS.EDITOR.CHANGE, {
      roomId,
      code: 'viewer unauthorized code',
      language: 'javascript',
    });

    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/only the active driver/i);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(driverUpdateSpy).not.toHaveBeenCalled();
    driver.off(SOCKET_EVENTS.EDITOR.UPDATE, driverUpdateSpy);
  });

  test('editor:change is rejected if sender is not a member of the room or if no driver exists', async () => {
    const [unjoinedClient, driverClient] = clients;
    const roomId = 'no-member-room';

    // unjoinedClient has not joined 'no-member-room'
    const notMemberAck = await emitAck(unjoinedClient, SOCKET_EVENTS.EDITOR.CHANGE, {
      roomId,
      code: 'some code',
      language: 'python',
    });
    expect(notMemberAck.ok).toBe(false);
    expect(notMemberAck.error).toMatch(/not a member/i);

    // Join and immediately leave to clear driver state
    await emitAck(driverClient, SOCKET_EVENTS.ROOM.JOIN, { roomId, token: generateToken('temp-id', 'Temp'), user: { name: 'Temp' } });
    await emitAck(driverClient, SOCKET_EVENTS.ROOM.LEAVE, { roomId });

    // Try editing in empty/no-driver room
    const noDriverAck = await emitAck(driverClient, SOCKET_EVENTS.EDITOR.CHANGE, {
      roomId,
      code: 'some code',
      language: 'python',
    });
    expect(noDriverAck.ok).toBe(false);
    expect(noDriverAck.error).toMatch(/not a member|no active driver/i);
  });

  test('room isolation: updates in Room A are never delivered to Room B', async () => {
    const [driverA, viewerA, driverB, viewerB] = clients;
    const roomA = 'room-alpha';
    const roomB = 'room-beta';

    await emitAck(driverA, SOCKET_EVENTS.ROOM.JOIN, { roomId: roomA, token: generateToken('driverA-id', 'Driver A'), user: { name: 'Driver A' } });
    await emitAck(viewerA, SOCKET_EVENTS.ROOM.JOIN, { roomId: roomA, token: generateToken('viewerA-id', 'Viewer A'), user: { name: 'Viewer A' } });

    await emitAck(driverB, SOCKET_EVENTS.ROOM.JOIN, { roomId: roomB, token: generateToken('driverB-id', 'Driver B'), user: { name: 'Driver B' } });
    await emitAck(viewerB, SOCKET_EVENTS.ROOM.JOIN, { roomId: roomB, token: generateToken('viewerB-id', 'Viewer B'), user: { name: 'Viewer B' } });

    const driverBUpdateSpy = jest.fn();
    const viewerBUpdateSpy = jest.fn();
    driverB.on(SOCKET_EVENTS.EDITOR.UPDATE, driverBUpdateSpy);
    viewerB.on(SOCKET_EVENTS.EDITOR.UPDATE, viewerBUpdateSpy);

    const viewerAUpdatePromise = nextEvent(viewerA, SOCKET_EVENTS.EDITOR.UPDATE);

    const ack = await emitAck(driverA, SOCKET_EVENTS.EDITOR.CHANGE, {
      roomId: roomA,
      code: 'print("Hello Room A")',
      language: 'python',
    });
    expect(ack.ok).toBe(true);

    const updateA = await viewerAUpdatePromise;
    expect(updateA.code).toBe('print("Hello Room A")');

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(driverBUpdateSpy).not.toHaveBeenCalled();
    expect(viewerBUpdateSpy).not.toHaveBeenCalled();

    driverB.off(SOCKET_EVENTS.EDITOR.UPDATE, driverBUpdateSpy);
    viewerB.off(SOCKET_EVENTS.EDITOR.UPDATE, viewerBUpdateSpy);
  });

  test('driver transfer changes edit authority seamlessly', async () => {
    const [userA, userB] = clients;
    const roomId = 'transfer-auth-room';

    await emitAck(userA, SOCKET_EVENTS.ROOM.JOIN, { roomId, token: generateToken('userA-id', 'User A'), user: { name: 'User A' } });
    await emitAck(userB, SOCKET_EVENTS.ROOM.JOIN, { roomId, token: generateToken('userB-id', 'User B'), user: { name: 'User B' } });

    // Initially userA is Driver, userB is Viewer
    const initialChange = await emitAck(userA, SOCKET_EVENTS.EDITOR.CHANGE, {
      roomId,
      code: 'initial code',
      language: 'cpp',
    });
    expect(initialChange.ok).toBe(true);

    const unauthorizedB = await emitAck(userB, SOCKET_EVENTS.EDITOR.CHANGE, {
      roomId,
      code: 'unauthorized code',
      language: 'cpp',
    });
    expect(unauthorizedB.ok).toBe(false);

    // Transfer driver from userA to userB
    const transferAck = await emitAck(userA, SOCKET_EVENTS.EDITOR.DRIVER_CHANGE, {
      roomId,
      newDriverId: userB.id,
    });
    expect(transferAck.ok).toBe(true);

    // Now userA should be rejected
    const oldDriverAck = await emitAck(userA, SOCKET_EVENTS.EDITOR.CHANGE, {
      roomId,
      code: 'old driver attempt',
      language: 'cpp',
    });
    expect(oldDriverAck.ok).toBe(false);
    expect(oldDriverAck.error).toMatch(/only the active driver/i);

    // Now userB should be accepted and broadcast to userA
    const updateReceivedByA = nextEvent(userA, SOCKET_EVENTS.EDITOR.UPDATE);
    const newDriverAck = await emitAck(userB, SOCKET_EVENTS.EDITOR.CHANGE, {
      roomId,
      code: '#include <iostream>',
      language: 'cpp',
    });
    expect(newDriverAck.ok).toBe(true);

    const update = await updateReceivedByA;
    expect(update.code).toBe('#include <iostream>');
    expect(update.updatedBy).toBe(userB.id);
  });

  test('correctly propagates language switching and cursor positions', async () => {
    const [driver, viewer] = clients;
    const roomId = 'lang-cursor-room';

    await emitAck(driver, SOCKET_EVENTS.ROOM.JOIN, { roomId, token: generateToken('driver-id', 'Driver'), user: { name: 'Driver' } });
    await emitAck(viewer, SOCKET_EVENTS.ROOM.JOIN, { roomId, token: generateToken('viewer-id', 'Viewer'), user: { name: 'Viewer' } });

    // 1. Language change with cursor
    const updatePromise1 = nextEvent(viewer, SOCKET_EVENTS.EDITOR.UPDATE);
    const ack1 = await emitAck(driver, SOCKET_EVENTS.EDITOR.CHANGE, {
      roomId,
      code: 'def solve(): pass',
      language: 'python',
      cursor: { line: 1, column: 12 },
    });
    expect(ack1.ok).toBe(true);

    const update1 = await updatePromise1;
    expect(update1).toEqual({
      code: 'def solve(): pass',
      language: 'python',
      cursor: { line: 1, column: 12 },
      updatedBy: driver.id,
    });

    // 2. Change without cursor
    const updatePromise2 = nextEvent(viewer, SOCKET_EVENTS.EDITOR.UPDATE);
    const ack2 = await emitAck(driver, SOCKET_EVENTS.EDITOR.CHANGE, {
      roomId,
      code: 'public class Main {}',
      language: 'java',
    });
    expect(ack2.ok).toBe(true);

    const update2 = await updatePromise2;
    expect(update2).toEqual({
      code: 'public class Main {}',
      language: 'java',
      updatedBy: driver.id,
    });
    expect(update2.cursor).toBeUndefined();
  });

  test('safely rejects malformed editor:change payloads', async () => {
    const [driver] = clients;
    const roomId = 'malformed-room';

    await emitAck(driver, SOCKET_EVENTS.ROOM.JOIN, { roomId, token: generateToken('driver-id', 'Driver'), user: { name: 'Driver' } });

    // Non-object payload
    const nonObj = await emitAck(driver, SOCKET_EVENTS.EDITOR.CHANGE, null);
    expect(nonObj.ok).toBe(false);
    expect(nonObj.error).toMatch(/object/i);

    // Missing / invalid roomId
    const invalidRoom = await emitAck(driver, SOCKET_EVENTS.EDITOR.CHANGE, {
      roomId: 12345,
      code: 'abc',
      language: 'javascript',
    });
    expect(invalidRoom.ok).toBe(false);
    expect(invalidRoom.error).toMatch(/roomId/i);

    // Non-string code
    const invalidCode = await emitAck(driver, SOCKET_EVENTS.EDITOR.CHANGE, {
      roomId,
      code: { not: 'a string' },
      language: 'javascript',
    });
    expect(invalidCode.ok).toBe(false);
    expect(invalidCode.error).toMatch(/code/i);

    // Missing / empty language
    const invalidLang = await emitAck(driver, SOCKET_EVENTS.EDITOR.CHANGE, {
      roomId,
      code: 'valid code',
      language: '',
    });
    expect(invalidLang.ok).toBe(false);
    expect(invalidLang.error).toMatch(/language/i);

    // Invalid cursor type (string or array)
    const invalidCursor = await emitAck(driver, SOCKET_EVENTS.EDITOR.CHANGE, {
      roomId,
      code: 'valid code',
      language: 'javascript',
      cursor: 'invalid-cursor-string',
    });
    expect(invalidCursor.ok).toBe(false);
    expect(invalidCursor.error).toMatch(/cursor/i);
  });

  test('rejects editor:change exceeding 64 KiB UTF-8 (ASCII & multibyte Unicode) without broadcasting', async () => {
    const [driver, viewer] = clients;
    const roomId = 'oversized-code-room';

    await emitAck(driver, SOCKET_EVENTS.ROOM.JOIN, { roomId, token: generateToken('driver-id', 'Driver'), user: { name: 'Driver' } });
    await emitAck(viewer, SOCKET_EVENTS.ROOM.JOIN, { roomId, token: generateToken('viewer-id', 'Viewer'), user: { name: 'Viewer' } });

    const viewerUpdateSpy = jest.fn();
    viewer.on(SOCKET_EVENTS.EDITOR.UPDATE, viewerUpdateSpy);

    // 1. Oversized ASCII input (65537 bytes)
    const oversizedAscii = 'a'.repeat(65537);
    const asciiAck = await emitAck(driver, SOCKET_EVENTS.EDITOR.CHANGE, {
      roomId,
      code: oversizedAscii,
      language: 'python',
    });
    expect(asciiAck.ok).toBe(false);
    expect(asciiAck.error).toMatch(/exceeds maximum allowed size of 64 KiB/i);

    // 2. Multibyte Unicode input: string length is 25,000 chars, but each char is 3 UTF-8 bytes = 75,000 bytes > 65,536 bytes
    const multibyteChar = '\u20AC'; // Euro sign (€), 3 bytes in UTF-8
    const oversizedUnicode = multibyteChar.repeat(25000);
    expect(oversizedUnicode.length).toBeLessThan(65536);
    expect(Buffer.byteLength(oversizedUnicode, 'utf8')).toBe(75000);

    const unicodeAck = await emitAck(driver, SOCKET_EVENTS.EDITOR.CHANGE, {
      roomId,
      code: oversizedUnicode,
      language: 'python',
    });
    expect(unicodeAck.ok).toBe(false);
    expect(unicodeAck.error).toMatch(/exceeds maximum allowed size of 64 KiB/i);

    // Verify viewer NEVER received an editor:update event
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(viewerUpdateSpy).not.toHaveBeenCalled();
    viewer.off(SOCKET_EVENTS.EDITOR.UPDATE, viewerUpdateSpy);
  });
});
