const request = require('supertest');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const Docker = require('dockerode');
const { generateToken } = require('../../backend/src/middleware/auth');
const executeRouter = require('../../backend/src/routes/execute');
const executionQueue = require('../../execution/engine/queue');
const executeCode = require('../../execution/engine/executeCode');
const { runInSandbox, parseMemoryToBytes } = require('../../execution/engine/executor');
const sandboxConfig = require('../../execution/engine/sandboxConfig');
const { validateExecutionRequest, executeCodeService } = require('../../backend/src/services/executionService');
const ExecutionRun = require('../../database/models/ExecutionRun');
const Room = require('../../database/models/Room');

const docker = new Docker();

describe('Security Remediation Batch 2: Sandbox & Resource Hardening', () => {
  jest.setTimeout(45000);

  beforeAll(() => {
    process.env.ALLOW_DEFAULT_DOCKER_FALLBACK = 'true';
    mongoose.connection.readyState = 1;
    jest.spyOn(ExecutionRun.prototype, 'save').mockResolvedValue(true);
  });

  // --------------------------------------------------------------------------
  // SEC-EXEC-01: Bound Execution Resource Overrides
  // --------------------------------------------------------------------------
  describe('SEC-EXEC-01: Bound Execution Resource Overrides', () => {
    test('accepts valid execution resources within bounds (timeout <= 10000ms, memory <= 256m)', () => {
      // Below bounds
      const resBelow = validateExecutionRequest({
        roomId: 'test-room',
        language: 'python',
        code: 'print("ok")',
        timeout: 5000,
        memory: '128m',
      });
      expect(resBelow.valid).toBe(true);

      // Exactly at maximum bounds
      const resAtMax = validateExecutionRequest({
        roomId: 'test-room',
        language: 'python',
        code: 'print("ok")',
        timeout: 10000,
        memory: '256m',
      });
      expect(resAtMax.valid).toBe(true);

      // Memory specified as numeric bytes at max limit (256 MiB)
      const resBytes = validateExecutionRequest({
        roomId: 'test-room',
        language: 'python',
        code: 'print("ok")',
        timeout: 10000,
        memory: 256 * 1024 * 1024,
      });
      expect(resBytes.valid).toBe(true);
    });

    test('rejects execution resource overrides exceeding maximum limits with clear errors', () => {
      // 1-hour timeout attack (from M0.9 audit)
      const resHourTimeout = validateExecutionRequest({
        roomId: 'test-room',
        language: 'python',
        code: 'print("ok")',
        timeout: 3600000,
        memory: '128m',
      });
      expect(resHourTimeout.valid).toBe(false);
      expect(resHourTimeout.error).toMatch(/timeout exceeds maximum allowed execution limit of 10000ms/i);

      // 32 GB memory attack (from M0.9 audit)
      const resExcessMemory = validateExecutionRequest({
        roomId: 'test-room',
        language: 'python',
        code: 'print("ok")',
        timeout: 5000,
        memory: '32g',
      });
      expect(resExcessMemory.valid).toBe(false);
      expect(resExcessMemory.error).toMatch(/memory exceeds maximum allowed container limit of 256m/i);
    });

    test('rejects invalid, negative, zero, and malformed timeout or memory inputs', () => {
      // Zero or negative timeout
      expect(validateExecutionRequest({ roomId: 'r', language: 'python', code: 'x', timeout: 0 }).valid).toBe(false);
      expect(validateExecutionRequest({ roomId: 'r', language: 'python', code: 'x', timeout: -1000 }).valid).toBe(false);
      expect(validateExecutionRequest({ roomId: 'r', language: 'python', code: 'x', timeout: NaN }).valid).toBe(false);

      // Malformed or negative memory
      expect(validateExecutionRequest({ roomId: 'r', language: 'python', code: 'x', memory: '-64m' }).valid).toBe(false);
      expect(validateExecutionRequest({ roomId: 'r', language: 'python', code: 'x', memory: 'invalid-unit' }).valid).toBe(false);
      expect(validateExecutionRequest({ roomId: 'r', language: 'python', code: 'x', memory: -500 }).valid).toBe(false);
      expect(validateExecutionRequest({ roomId: 'r', language: 'python', code: 'x', memory: NaN }).valid).toBe(false);
    });

    test('parseMemoryToBytes handles units and safely returns null for invalid inputs', () => {
      expect(parseMemoryToBytes('128m')).toBe(128 * 1024 * 1024);
      expect(parseMemoryToBytes('256M')).toBe(256 * 1024 * 1024);
      expect(parseMemoryToBytes('64k')).toBe(64 * 1024);
      expect(parseMemoryToBytes('1g')).toBe(1024 * 1024 * 1024);
      expect(parseMemoryToBytes(268435456)).toBe(268435456);

      // Malformed and edge cases
      expect(parseMemoryToBytes('-128m')).toBeNull();
      expect(parseMemoryToBytes('0m')).toBeNull();
      expect(parseMemoryToBytes('abc')).toBeNull();
      expect(parseMemoryToBytes(NaN)).toBeNull();
      expect(parseMemoryToBytes(-1)).toBeNull();
      expect(parseMemoryToBytes({})).toBeNull();
    });

    test('execution engine defensively enforces hard upper bounds on internal calls', async () => {
      // Even if internal caller attempts to bypass validation with 60000ms and 16g,
      // runInSandbox caps them at MAX_TIMEOUT_MS and MAX_MEMORY_BYTES
      const result = await executeCode({
        language: 'python',
        code: 'print("defensive boundary ok")',
        timeout: 60000,
        memory: '16g',
      });
      expect(result.status).toBe('completed');
      expect(result.stdout.trim()).toBe('defensive boundary ok');
    });
  });

  // --------------------------------------------------------------------------
  // SEC-EXEC-02: Bound stdout/stderr Buffering
  // --------------------------------------------------------------------------
  describe('SEC-EXEC-02: Bound stdout/stderr Buffering', () => {
    test('terminates container and truncates output when stdout exceeds 64 KiB', async () => {
      const containersBefore = await docker.listContainers({ all: true });

      // Python script generating 75,000 bytes of stdout (> 64 KiB threshold)
      const oversizedScript = [
        'import sys',
        'sys.stdout.write("A" * 75000)',
        'sys.stdout.flush()',
      ].join('\n');

      // Test sandbox engine directly for deep result classification
      const rawResult = await runInSandbox({
        language: 'python',
        code: oversizedScript,
      });

      expect(rawResult.status).toBe('failed');
      expect(rawResult.outputLimitExceeded).toBe(true);
      expect(rawResult.timedOut).toBe(false);
      expect(rawResult.exitCode).toBe(137);
      expect(rawResult.stdout).toContain('[Output truncated: exceeded 64KB limit]');
      expect(rawResult.stderr).toContain('exceeded maximum limit of 64KB');

      // Retained bytes must not exceed limit + marker buffer
      const stdoutBytes = Buffer.byteLength(rawResult.stdout, 'utf8');
      expect(stdoutBytes).toBeLessThanOrEqual(sandboxConfig.MAX_OUTPUT_BUFFER_BYTES + 256);

      // Test executeCode interface
      const parsedResult = await executeCode({
        language: 'python',
        code: oversizedScript,
      });
      expect(parsedResult.status).toBe('failed');
      expect(parsedResult.exitCode).toBe(137);
      expect(parsedResult.stdout).toContain('[Output truncated: exceeded 64KB limit]');

      // Verify no orphaned container was leaked
      const containersAfter = await docker.listContainers({ all: true });
      const orphanRunners = containersAfter.filter(
        (c) =>
          c.Image.includes('codecollab-runner-python') &&
          !containersBefore.some((b) => b.Id === c.Id)
      );
      expect(orphanRunners.length).toBe(0);
    });

    test('terminates container and truncates output when stderr exceeds 64 KiB', async () => {
      const containersBefore = await docker.listContainers({ all: true });

      // Python script generating 75,000 bytes of stderr (> 64 KiB threshold)
      const oversizedStderrScript = [
        'import sys',
        'sys.stderr.write("E" * 75000)',
        'sys.stderr.flush()',
      ].join('\n');

      const rawResult = await runInSandbox({
        language: 'python',
        code: oversizedStderrScript,
      });

      expect(rawResult.status).toBe('failed');
      expect(rawResult.outputLimitExceeded).toBe(true);
      expect(rawResult.timedOut).toBe(false);
      expect(rawResult.exitCode).toBe(137);
      expect(rawResult.stderr).toContain('[Output truncated: exceeded 64KB limit]');
      expect(rawResult.stderr).toContain('exceeded maximum limit of 64KB');

      const stderrBytes = Buffer.byteLength(rawResult.stderr, 'utf8');
      expect(stderrBytes).toBeLessThanOrEqual(sandboxConfig.MAX_OUTPUT_BUFFER_BYTES + 256);

      // Verify no container leak
      const containersAfter = await docker.listContainers({ all: true });
      const orphanRunners = containersAfter.filter(
        (c) =>
          c.Image.includes('codecollab-runner-python') &&
          !containersBefore.some((b) => b.Id === c.Id)
      );
      expect(orphanRunners.length).toBe(0);
    });

    test('normal output within bounds is preserved completely without truncation', async () => {
      const normalScript = 'print("Line 1"); print("Line 2")';
      const result = await executeCode({
        language: 'python',
        code: normalScript,
      });

      expect(result.status).toBe('completed');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('Line 1\nLine 2');
    });

    test('normal timeout behavior is preserved and not confused with output termination', async () => {
      const sleepScript = 'import time\ntime.sleep(5)';
      const rawResult = await runInSandbox({
        language: 'python',
        code: sleepScript,
        timeout: 1000,
      });

      expect(rawResult.status).toBe('timeout');
      expect(rawResult.exitCode).toBe(124);
      expect(rawResult.timedOut).toBe(true);
      expect(rawResult.outputLimitExceeded).toBeUndefined();
      expect(rawResult.stderr).toContain('Execution timed out after 1000ms');

      const parsedResult = await executeCode({
        language: 'python',
        code: sleepScript,
        timeout: 1000,
      });
      expect(parsedResult.status).toBe('timeout');
      expect(parsedResult.exitCode).toBe(124);
    });
  });

  // --------------------------------------------------------------------------
  // SEC-EXEC-03: Harden Runner Containers
  // --------------------------------------------------------------------------
  describe('SEC-EXEC-03: Harden Runner Containers', () => {
    test('passes hardened Docker HostConfig options', async () => {
      const createContainerSpy = jest.spyOn(Docker.prototype, 'createContainer');

      await executeCode({
        language: 'python',
        code: 'print("hostconfig check")',
      });

      expect(createContainerSpy).toHaveBeenCalled();
      const callArgs = createContainerSpy.mock.calls[createContainerSpy.mock.calls.length - 1][0];
      const hostConfig = callArgs.HostConfig;

      // Verify HostConfig hardening flags
      expect(hostConfig.ReadonlyRootfs).toBe(true);
      expect(hostConfig.CapDrop).toEqual(['ALL']);
      expect(hostConfig.SecurityOpt).toEqual(['no-new-privileges:true']);
      expect(hostConfig.Tmpfs).toEqual({ '/tmp': 'rw,noexec,nosuid,size=32m' });

      // Retain existing resource limits
      expect(hostConfig.NetworkMode).toBe('none');
      expect(hostConfig.PidsLimit).toBe(64);
      expect(hostConfig.NanoCPUs).toBe(500000000); // 0.5 CPU
      expect(hostConfig.Memory).toBe(256 * 1024 * 1024); // 256 MiB
      expect(hostConfig.MemorySwap).toBe(256 * 1024 * 1024); // Swap disabled

      createContainerSpy.mockRestore();
    });

    test('verifies read-only rootfs prevents writes to application and root directories', async () => {
      // Attempt to write a file in /app (should fail on read-only root filesystem)
      const writeAppScript = [
        'try:',
        '    with open("/app/hacked.txt", "w") as f:',
        '        f.write("exploit")',
        '    print("VULNERABLE: write succeeded")',
        'except OSError as e:',
        '    print(f"PROTECTED: {type(e).__name__}")',
      ].join('\n');

      const result = await executeCode({
        language: 'python',
        code: writeAppScript,
      });

      expect(result.status).toBe('completed');
      expect(result.stdout).toContain('PROTECTED: OSError');
      expect(result.stdout).not.toContain('VULNERABLE');
    });

    test('verifies writable temporary storage in /tmp works under read-only rootfs', async () => {
      const tmpTestScript = [
        'with open("/tmp/scratch.txt", "w") as f:',
        '    f.write("hello from tmpfs")',
        'with open("/tmp/scratch.txt", "r") as f:',
        '    print(f.read())',
      ].join('\n');

      const result = await executeCode({
        language: 'python',
        code: tmpTestScript,
      });

      expect(result.status).toBe('completed');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello from tmpfs');
    });
  });

  // --------------------------------------------------------------------------
  // SEC-EXEC-04: Limit Submitted Code Size (64 KiB UTF-8)
  // --------------------------------------------------------------------------
  describe('SEC-EXEC-04: Limit Submitted Code Size (64 KiB UTF-8)', () => {
    test('backend execution service rejects ASCII code exceeding 64 KiB', () => {
      const oversizedAscii = 'x'.repeat(65537);
      const validation = validateExecutionRequest({
        roomId: 'test-room',
        language: 'python',
        code: oversizedAscii,
      });

      expect(validation.valid).toBe(false);
      expect(validation.error).toMatch(/code exceeds maximum allowed size of 64KB/i);
    });

    test('backend execution service rejects multibyte Unicode code exceeding 64 KiB', () => {
      // 25,000 euro symbols (€ = 3 bytes each = 75,000 bytes > 65,536 bytes)
      // Note: JavaScript string length is only 25,000 (< 65,536)
      const euroChar = '\u20AC';
      const oversizedUnicode = euroChar.repeat(25000);

      expect(oversizedUnicode.length).toBe(25000);
      expect(Buffer.byteLength(oversizedUnicode, 'utf8')).toBe(75000);

      const validation = validateExecutionRequest({
        roomId: 'test-room',
        language: 'python',
        code: oversizedUnicode,
      });

      expect(validation.valid).toBe(false);
      expect(validation.error).toMatch(/code exceeds maximum allowed size of 64KB/i);
    });

    test('defensive engine check in executeCode rejects oversized code', async () => {
      const oversizedAscii = 'print(1)\n' + 'y'.repeat(65536);
      await expect(
        executeCode({
          language: 'python',
          code: oversizedAscii,
        })
      ).rejects.toThrow(/code exceeds maximum allowed size of 64KB/i);
    });
  });

  // --------------------------------------------------------------------------
  // SEC-EXEC-05: Bound BullMQ Backlog (Max 25 Waiting Jobs)
  // --------------------------------------------------------------------------
  describe('SEC-EXEC-05: Bound BullMQ Backlog (Max 25 Waiting Jobs)', () => {
    test('queue.add rejects with 429 when waiting count reaches capacity (25)', async () => {
      const queueInstance = executionQueue.getQueue();
      const getWaitingCountSpy = jest
        .spyOn(queueInstance, 'getWaitingCount')
        .mockResolvedValue(25);

      await expect(
        executionQueue.add({
          language: 'python',
          code: 'print("test")',
        })
      ).rejects.toMatchObject({
        status: 429,
        message: expect.stringMatching(/capacity \(max 25 jobs waiting\)/i),
      });

      getWaitingCountSpy.mockRestore();
    });

    test('backend executeCodeService maps queue capacity limit to HTTP 429', async () => {
      const testRoom = 'room-capacity-service-test';
      const testUserId = new mongoose.Types.ObjectId().toString();

      jest.spyOn(Room, 'findOne').mockResolvedValue({
        roomId: testRoom,
        owner: testUserId,
        activeDriver: testUserId,
        members: [testUserId],
      });

      const getLengthSpy = jest
        .spyOn(executionQueue, 'getLength')
        .mockResolvedValue(25);

      await expect(
        executeCodeService({
          roomId: testRoom,
          language: 'python',
          code: 'print("test")',
          user: { _id: testUserId },
          io: null,
        })
      ).rejects.toMatchObject({
        status: 429,
        message: expect.stringMatching(/Execution queue is at capacity/i),
      });

      getLengthSpy.mockRestore();
    });

    test('POST /api/execute returns HTTP 429 when queue capacity is exceeded', async () => {
      const testRoom = 'room-capacity-test';
      const mockDriverUser = {
        _id: new mongoose.Types.ObjectId().toString(),
        username: 'driverCap',
        email: 'driverCap@example.com',
      };
      const token = generateToken(mockDriverUser);

      // Mock Room to confirm user is active driver via DB
      jest.spyOn(Room, 'findOne').mockResolvedValue({
        roomId: testRoom,
        owner: mockDriverUser._id,
        activeDriver: mockDriverUser._id,
        members: [mockDriverUser._id],
      });

      // Mock queue getLength to simulate 25 jobs waiting
      const getLengthSpy = jest
        .spyOn(executionQueue, 'getLength')
        .mockResolvedValue(25);

      const app = express();
      app.use(express.json());
      app.use('/api/execute', executeRouter);

      const res = await request(app)
        .post('/api/execute')
        .set('Authorization', `Bearer ${token}`)
        .send({
          roomId: testRoom,
          language: 'python',
          code: 'print("capacity test")',
        });

      expect(res.status).toBe(429);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/Execution queue is at capacity \(max 25 jobs waiting\)/i);

      getLengthSpy.mockRestore();
    });
  });

  afterAll(async () => {
    if (executionQueue && typeof executionQueue.close === 'function') {
      await executionQueue.close();
    }
  });
});
