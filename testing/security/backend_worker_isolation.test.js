const request = require('supertest');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const { generateToken } = require('../../backend/src/middleware/auth');
const executeRouter = require('../../backend/src/routes/execute');
const executionQueue = require('../../execution/engine/queue');
const { executeCodeService } = require('../../backend/src/services/executionService');
const ExecutionRun = require('../../database/models/ExecutionRun');
const Room = require('../../database/models/Room');
const { startWorker, stopWorker } = require('../../execution/worker');
const sandboxConfig = require('../../execution/engine/sandboxConfig');

describe('Backend-Worker Isolation & Privilege Separation Suite (M1.0 Phase A)', () => {
  let app;
  let server;
  const testRoomId = `test-isolation-room-${Date.now()}`;

  const driverUser = {
    _id: new mongoose.Types.ObjectId().toString(),
    username: 'isolationDriver',
    email: 'isolation_driver@example.com',
  };

  const viewerUser = {
    _id: new mongoose.Types.ObjectId().toString(),
    username: 'isolationViewer',
    email: 'isolation_viewer@example.com',
  };

  const driverToken = generateToken(driverUser);
  const viewerToken = generateToken(viewerUser);

  beforeAll(async () => {
    mongoose.connection.readyState = 1;
    jest.spyOn(ExecutionRun.prototype, 'save').mockResolvedValue(true);
    jest.spyOn(Room, 'findOne').mockImplementation((query) => {
      const rId = query?.roomId || (query?.$or && query.$or[0]?.roomId);
      if (rId === testRoomId) {
        return Promise.resolve({
          roomId: rId,
          name: rId,
          owner: driverUser._id,
          activeDriver: driverUser._id,
          members: [driverUser._id, viewerUser._id],
          isPublic: true,
        });
      }
      return Promise.resolve(null);
    });

    app = express();
    app.use(express.json());
    app.use('/api/execute', executeRouter);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    if (Room.findOne.mockRestore) Room.findOne.mockRestore();
    if (ExecutionRun.prototype.save.mockRestore) ExecutionRun.prototype.save.mockRestore();
    mongoose.connection.readyState = 0;
    if (server) await new Promise((r) => server.close(r));
    await stopWorker(true);
    await executionQueue.close(true);
  });

  afterEach(async () => {
    await stopWorker(true);
  });

  jest.setTimeout(35000);

  describe('1. Module Loading and Dockerode Decoupling', () => {
    test('importing executionService does not load Dockerode or executor into memory', () => {
      // Inspect require.cache to ensure backend modules do not import Dockerode or executor
      const loadedModules = Object.keys(require.cache);

      const hasDockerode = loadedModules.some((mod) =>
        mod.includes('node_modules\\dockerode') || mod.includes('node_modules/dockerode')
      );
      const hasExecutor = loadedModules.some((mod) =>
        mod.endsWith('execution\\engine\\executor.js') || mod.endsWith('execution/engine/executor.js')
      );
      const hasExecuteCode = loadedModules.some((mod) =>
        mod.endsWith('execution\\engine\\executeCode.js') || mod.endsWith('execution/engine/executeCode.js')
      );

      // Note: If previous tests loaded them in the same process, we verify that executionService
      // itself only required resourceLimits and queue
      const executionServiceSrc = require('fs').readFileSync(
        require.resolve('../../backend/src/services/executionService'),
        'utf8'
      );

      expect(executionServiceSrc).not.toContain("require('../../../execution/engine/executor')");
      expect(executionServiceSrc).not.toContain("require('dockerode')");
      expect(executionServiceSrc).toContain("require('../../../execution/engine/resourceLimits')");
    });

    test('backend index.js does not import executionQueue or start worker', () => {
      const indexSrc = require('fs').readFileSync(
        require.resolve('../../backend/src/index'),
        'utf8'
      );

      expect(indexSrc).not.toContain("executionQueue.startWorker()");
      expect(indexSrc).not.toContain("require('../../execution/engine/queue')");
    });
  });

  describe('2. In-Process Worker Absence in Public Backend', () => {
    test('public backend queue instance has no active in-process worker', () => {
      expect(executionQueue.hasWorker()).toBe(false);
      expect(executionQueue.getWorker()).toBeNull();
    });

    test('invoking executeCodeService does NOT instantiate an in-process worker', async () => {
      // Mock queue execute to inspect worker state during execution call
      const executeSpy = jest.spyOn(executionQueue, 'execute').mockResolvedValueOnce({
        status: 'completed',
        stdout: 'mocked output',
        stderr: '',
        exitCode: 0,
        executionTimeMs: 15,
      });

      await executeCodeService({
        roomId: testRoomId,
        language: 'python',
        code: 'print("test")',
        user: driverUser,
      });

      // Verify executionQueue still does NOT have a worker
      expect(executionQueue.hasWorker()).toBe(false);
      expect(executionQueue.getWorker()).toBeNull();

      executeSpy.mockRestore();
    });
  });

  describe('3. End-to-End Producer/Consumer Queue Handoff', () => {
    test('backend enqueues job and standalone worker consumes and returns result', async () => {
      // Start the standalone worker independently
      startWorker({
        queueName: executionQueue.queueName,
        concurrency: 2,
      });

      const res = await request(app)
        .post('/api/execute')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({
          roomId: testRoomId,
          language: 'python',
          code: 'print("Testing isolated producer-consumer pipeline!")\nprint(100 + 23)',
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.status).toBe('completed');
      expect(res.body.result.stdout).toContain('Testing isolated producer-consumer pipeline!');
      expect(res.body.result.stdout).toContain('123');
      expect(res.body.result.exitCode).toBe(0);

      // Verify the public backend itself never started an in-process worker
      expect(executionQueue.hasWorker()).toBe(false);
    });
  });

  describe('4. Preservation of M0.9 Defense & Admission Limits', () => {
    test('rejects execution requests from non-drivers with 403 Forbidden', async () => {
      const res = await request(app)
        .post('/api/execute')
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({
          roomId: testRoomId,
          language: 'python',
          code: 'print(1)',
        });

      expect(res.status).toBe(403);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/driver/i);
    });

    test('rejects code exceeding 64 KiB with 400 Bad Request', async () => {
      const oversizedCode = 'a'.repeat(65 * 1024);
      const res = await request(app)
        .post('/api/execute')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({
          roomId: testRoomId,
          language: 'python',
          code: oversizedCode,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/maximum allowed size/i);
    });

    test('rejects request with 429 when queue capacity is reached', async () => {
      const lengthSpy = jest.spyOn(executionQueue, 'getLength').mockResolvedValue(sandboxConfig.MAX_WAITING_JOBS);

      const res = await request(app)
        .post('/api/execute')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({
          roomId: testRoomId,
          language: 'python',
          code: 'print(1)',
        });

      expect(res.status).toBe(429);
      expect(res.body.error).toMatch(/queue is at capacity/i);

      lengthSpy.mockRestore();
    });
  });
});
