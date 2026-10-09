const request = require('supertest');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const { io: connectClient } = require('socket.io-client');
const { initRealtimeServer } = require('../../realtime/server');
const { generateToken } = require('../../backend/src/middleware/auth');
const executeRouter = require('../../backend/src/routes/execute');
const executionQueue = require('../../execution/engine/queue');
const ExecutionRun = require('../../database/models/ExecutionRun');

const nextEvent = (socket, event) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, 4000);
    const handler = (payload) => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(event, handler);
  });

const emitAck = (socket, event, payload) =>
  new Promise((resolve, reject) => {
    socket.timeout(3000).emit(event, payload, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });

describe('Backend Execution API Tests (POST /api/execute - M0.5d)', () => {
  let app;
  let server;
  let io;
  let driverClient;
  let viewerClient;
  let otherRoomClient;

  const driverUser = {
    _id: new mongoose.Types.ObjectId().toString(),
    username: 'driverUser',
    email: 'driver@example.com',
  };

  const viewerUser = {
    _id: new mongoose.Types.ObjectId().toString(),
    username: 'viewerUser',
    email: 'viewer@example.com',
  };

  const driverToken = generateToken(driverUser);
  const viewerToken = generateToken(viewerUser);

  const testRoomId = `test-exec-room-${Date.now()}`;
  const otherRoomId = `other-room-${Date.now()}`;

  beforeAll(async () => {
    // Start BullMQ execution worker
    executionQueue.startWorker();

    app = express();
    app.use(express.json());
    server = http.createServer(app);
    io = initRealtimeServer(server);

    app.set('io', io);
    app.use((req, res, next) => {
      req.io = io;
      next();
    });

    app.use('/api/execute', executeRouter);

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    // Connect socket clients
    driverClient = connectClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      forceNew: true,
    });
    viewerClient = connectClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      forceNew: true,
    });
    otherRoomClient = connectClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      forceNew: true,
    });

    await Promise.all([
      nextEvent(driverClient, 'connect'),
      nextEvent(viewerClient, 'connect'),
      nextEvent(otherRoomClient, 'connect'),
    ]);

    // Driver joins testRoomId -> becomes active driver
    await emitAck(driverClient, 'room:join', { roomId: testRoomId, user: driverUser });

    // Viewer joins testRoomId -> becomes viewer
    await emitAck(viewerClient, 'room:join', { roomId: testRoomId, user: viewerUser });

    // Other client joins otherRoomId
    await emitAck(otherRoomClient, 'room:join', { roomId: otherRoomId, user: { username: 'other' } });
  });

  afterAll(async () => {
    if (driverClient) driverClient.disconnect();
    if (viewerClient) viewerClient.disconnect();
    if (otherRoomClient) otherRoomClient.disconnect();
    if (io) await new Promise((r) => io.close(r));
    if (server) await new Promise((r) => server.close(r));
    await executionQueue.close(true);
  });

  // Sufficient timeout for Docker execution
  jest.setTimeout(35000);

  describe('1. Authentication & Authorization Enforcement', () => {
    test('should reject unauthenticated execution requests with 401', async () => {
      const res = await request(app)
        .post('/api/execute')
        .send({
          roomId: testRoomId,
          language: 'python',
          code: 'print("hello")',
        });

      expect(res.status).toBe(401);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/no token provided/i);
    });

    test('should reject invalid token with 401', async () => {
      const res = await request(app)
        .post('/api/execute')
        .set('Authorization', 'Bearer invalid.token.payload')
        .send({
          roomId: testRoomId,
          language: 'python',
          code: 'print("hello")',
        });

      expect(res.status).toBe(401);
      expect(res.body.ok).toBe(false);
    });

    test('should reject viewer execution attempt with 403', async () => {
      const res = await request(app)
        .post('/api/execute')
        .set('Authorization', `Bearer ${viewerToken}`)
        .set('x-socket-id', viewerClient.id)
        .send({
          roomId: testRoomId,
          language: 'python',
          code: 'print("unauthorized")',
        });

      expect(res.status).toBe(403);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/only the active room driver can execute code/i);
    });

    test('should reject execution in non-existent or unjoined room with 404', async () => {
      const res = await request(app)
        .post('/api/execute')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({
          roomId: 'non-existent-room-99999',
          language: 'python',
          code: 'print("hello")',
        });

      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
    });
  });

  describe('2. Request Payload Validation', () => {
    test('should reject request missing roomId with 400', async () => {
      const res = await request(app)
        .post('/api/execute')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({
          language: 'python',
          code: 'print(1)',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/roomId is required/i);
    });

    test('should reject request missing language with 400', async () => {
      const res = await request(app)
        .post('/api/execute')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({
          roomId: testRoomId,
          code: 'print(1)',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/language is required/i);
    });

    test('should reject unsupported language with 400', async () => {
      const res = await request(app)
        .post('/api/execute')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({
          roomId: testRoomId,
          language: 'ruby',
          code: 'puts 1',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/unsupported language/i);
    });

    test('should reject placeholder language without active runner (cpp / java) with 400', async () => {
      const res = await request(app)
        .post('/api/execute')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({
          roomId: testRoomId,
          language: 'cpp',
          code: 'int main() {}',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not yet supported/i);
    });

    test('should reject invalid timeout with 400', async () => {
      const res = await request(app)
        .post('/api/execute')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({
          roomId: testRoomId,
          language: 'python',
          code: 'print(1)',
          timeout: -500,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/positive number/i);
    });
  });

  describe('3. Successful Driver Execution and Realtime Broadcasts', () => {
    test('should execute Python code, persist run, and broadcast realtime completion events to room members', async () => {
      // Set up event listeners for both Driver and Viewer
      const driverStartedEvent = nextEvent(driverClient, 'execution:started');
      const viewerStartedEvent = nextEvent(viewerClient, 'execution:started');
      const driverCompletedEvent = nextEvent(driverClient, 'execution:completed');
      const viewerCompletedEvent = nextEvent(viewerClient, 'execution:completed');

      // Unrelated room client should NOT receive events
      const unexpectedOtherRoomEvent = jest.fn();
      otherRoomClient.on('execution:started', unexpectedOtherRoomEvent);
      otherRoomClient.on('execution:completed', unexpectedOtherRoomEvent);

      const res = await request(app)
        .post('/api/execute')
        .set('Authorization', `Bearer ${driverToken}`)
        .set('x-socket-id', driverClient.id)
        .send({
          roomId: testRoomId,
          language: 'python',
          code: 'print("Hello from API Driver Execution!")\nprint(10 + 20)',
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.status).toBe('completed');
      expect(res.body.runId).toBeDefined();
      expect(res.body.result.stdout).toContain('Hello from API Driver Execution!');
      expect(res.body.result.stdout).toContain('30');
      expect(res.body.result.exitCode).toBe(0);
      expect(res.body.result.executionTimeMs).toBeGreaterThan(0);

      // Verify realtime started events
      const started = await driverStartedEvent;
      expect(started.runId).toBe(res.body.runId);
      expect(started.roomId).toBe(testRoomId);
      expect(started.status).toBe('queued');

      const viewerStarted = await viewerStartedEvent;
      expect(viewerStarted.runId).toBe(res.body.runId);

      // Verify realtime completed events
      const completed = await driverCompletedEvent;
      expect(completed.runId).toBe(res.body.runId);
      expect(completed.status).toBe('completed');
      expect(completed.stdout).toContain('Hello from API Driver Execution!');
      expect(completed.exitCode).toBe(0);

      const viewerCompleted = await viewerCompletedEvent;
      expect(viewerCompleted.runId).toBe(res.body.runId);
      expect(viewerCompleted.status).toBe('completed');

      // Room isolation check
      await new Promise((r) => setTimeout(r, 50));
      expect(unexpectedOtherRoomEvent).not.toHaveBeenCalled();
      otherRoomClient.off('execution:started', unexpectedOtherRoomEvent);
      otherRoomClient.off('execution:completed', unexpectedOtherRoomEvent);
    });
  });

  describe('4. Execution Failure and Timeout Handling', () => {
    test('should handle Python runtime failure and emit execution:failed event', async () => {
      const viewerFailedEvent = nextEvent(viewerClient, 'execution:failed');

      const res = await request(app)
        .post('/api/execute')
        .set('Authorization', `Bearer ${driverToken}`)
        .set('x-socket-id', driverClient.id)
        .send({
          roomId: testRoomId,
          language: 'python',
          code: 'raise ValueError("Deliberate API runtime test error")',
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.status).toBe('failed');
      expect(res.body.result.exitCode).not.toBe(0);
      expect(res.body.result.stderr).toContain('ValueError: Deliberate API runtime test error');

      const failedEvent = await viewerFailedEvent;
      expect(failedEvent.runId).toBe(res.body.runId);
      expect(failedEvent.status).toBe('failed');
      expect(failedEvent.stderr).toContain('ValueError: Deliberate API runtime test error');
    });

    test('should handle execution timeout and emit execution:failed event with status timeout', async () => {
      const viewerTimeoutEvent = nextEvent(viewerClient, 'execution:failed');

      const res = await request(app)
        .post('/api/execute')
        .set('Authorization', `Bearer ${driverToken}`)
        .set('x-socket-id', driverClient.id)
        .send({
          roomId: testRoomId,
          language: 'python',
          code: 'import time\ntime.sleep(10)',
          timeout: 1200,
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.status).toBe('timeout');
      expect(res.body.result.exitCode).toBe(124);
      expect(res.body.result.stderr).toContain('Execution timed out after 1200ms');

      const timeoutEvent = await viewerTimeoutEvent;
      expect(timeoutEvent.runId).toBe(res.body.runId);
      expect(timeoutEvent.status).toBe('timeout');
      expect(timeoutEvent.exitCode).toBe(124);
    });
  });
});
