const { startWorker, stopWorker, shutdown, getWorker, processJob, sanitizeRedisUrl, validateWorkerPreflight } = require('../../execution/worker');
const { ExecutionQueue } = require('../../execution/engine/queue');
const executeCode = require('../../execution/engine/executeCode');
const { verifyRedisPreflight } = require('../redisTestHelper');

describe('Standalone Execution Worker Suite (M1.0 Phase A)', () => {
  const testQueueName = `test-worker-queue-${Date.now()}`;
  let testQueue;
  let workerInstance;

  beforeAll(async () => {
    await verifyRedisPreflight();
    testQueue = new ExecutionQueue({
      queueName: testQueueName,
      concurrency: 2,
    });
  });

  afterAll(async () => {
    await stopWorker(true);
    if (testQueue) {
      await testQueue.close(true);
    }
  });

  afterEach(async () => {
    await stopWorker(true);
  });

  // Give real container operations sufficient test timeout
  jest.setTimeout(35000);

  describe('1. Worker Initialization and Idempotency', () => {
    test('startWorker creates and registers an active BullMQ Worker', () => {
      workerInstance = startWorker({
        queueName: testQueueName,
        concurrency: 2,
      });

      expect(workerInstance).toBeDefined();
      expect(typeof workerInstance.on).toBe('function');
      expect(getWorker()).toBe(workerInstance);
    });

    test('startWorker avoids duplicate workers when called multiple times', () => {
      const firstWorker = startWorker({
        queueName: testQueueName,
        concurrency: 2,
      });

      const secondWorker = startWorker({
        queueName: testQueueName,
        concurrency: 2,
      });

      expect(secondWorker).toBe(firstWorker);
      expect(getWorker()).toBe(firstWorker);
    });

    test('stopWorker terminates the active worker and resets state', async () => {
      startWorker({
        queueName: testQueueName,
      });
      expect(getWorker()).not.toBeNull();

      await stopWorker(true);
      expect(getWorker()).toBeNull();
    });
  });

  describe('2. Safe Logging and Credential Sanitization', () => {
    test('sanitizeRedisUrl redacts passwords from connection strings', () => {
      expect(sanitizeRedisUrl('redis://:supersecret@127.0.0.1:6379/0')).toBe('redis://:***@127.0.0.1:6379/0');
      expect(sanitizeRedisUrl('redis://myuser:mypassword@redis.host:6380/1')).toBe('redis://myuser:***@redis.host:6380/1');
      expect(sanitizeRedisUrl('redis://localhost:6379')).toBe('redis://localhost:6379');
      expect(sanitizeRedisUrl('')).toBe('');
      expect(sanitizeRedisUrl(null)).toBe('');
    });
  });

  describe('3. Job Consumption and Result Contract via BullMQ', () => {
    test('standalone worker consumes a Python execution job from BullMQ and returns completed result', async () => {
      // Start the standalone worker on the test queue
      workerInstance = startWorker({
        queueName: testQueueName,
        concurrency: 2,
      });

      const result = await testQueue.execute({
        language: 'python',
        code: 'print("Hello from Standalone Worker!")\nprint(7 * 6)',
      });

      expect(result).toBeDefined();
      expect(result.status).toBe('completed');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Hello from Standalone Worker!');
      expect(result.stdout).toContain('42');
      expect(result.executionTimeMs).toBeGreaterThan(0);
    });

    test('standalone worker surfaces syntax and runtime errors as failed status', async () => {
      workerInstance = startWorker({
        queueName: testQueueName,
        concurrency: 2,
      });

      const failResult = await testQueue.execute({
        language: 'python',
        code: 'raise RuntimeError("Standalone worker runtime test error")',
      });

      expect(failResult).toBeDefined();
      expect(failResult.status).toBe('failed');
      expect(failResult.exitCode).not.toBe(0);
      expect(failResult.stderr).toContain('RuntimeError: Standalone worker runtime test error');
    });

    test('standalone worker surfaces execution timeout as timeout status', async () => {
      workerInstance = startWorker({
        queueName: testQueueName,
        concurrency: 2,
      });

      const timeoutResult = await testQueue.execute({
        language: 'python',
        code: 'import time\ntime.sleep(10)',
        timeout: 1000,
      });

      expect(timeoutResult).toBeDefined();
      expect(timeoutResult.status).toBe('timeout');
      expect(timeoutResult.exitCode).toBe(124);
      expect(timeoutResult.stderr).toContain('Execution timed out after 1000ms');
    });
  });

  describe('4. Bounded Concurrency Enforcement', () => {
    test('worker respects configured concurrency limits', async () => {
      const concurrencyQueueName = `test-worker-concurrency-${Date.now()}`;
      const concurrencyQueue = new ExecutionQueue({
        queueName: concurrencyQueueName,
        concurrency: 2,
      });

      let activeCount = 0;
      let maxObservedActive = 0;

      // Custom worker options to verify bounded execution
      const worker = startWorker({
        queueName: concurrencyQueueName,
        concurrency: 2,
        workerOptions: {
          concurrency: 2,
        },
      });

      // Spy on processJob to track concurrency
      const originalProcess = worker.processFn;
      worker.processFn = async (job) => {
        activeCount++;
        maxObservedActive = Math.max(maxObservedActive, activeCount);
        await new Promise((r) => setTimeout(r, 150));
        activeCount--;
        return { ok: true, id: job.id, status: 'completed' };
      };

      try {
        const jobPromises = [
          concurrencyQueue.execute({ language: 'python', code: 'print(1)' }),
          concurrencyQueue.execute({ language: 'python', code: 'print(2)' }),
          concurrencyQueue.execute({ language: 'python', code: 'print(3)' }),
          concurrencyQueue.execute({ language: 'python', code: 'print(4)' }),
        ];

        const results = await Promise.all(jobPromises);
        expect(results.length).toBe(4);
        expect(maxObservedActive).toBeLessThanOrEqual(2);
      } finally {
        await concurrencyQueue.close(true);
      }
    });
  });

  describe('5. Graceful Teardown and Signal Handling', () => {
    test('shutdown cleans up active worker without throwing', async () => {
      startWorker({
        queueName: testQueueName,
      });

      expect(getWorker()).not.toBeNull();
      await shutdown('SIGTERM');
      expect(getWorker()).toBeNull();
    });
  });

  describe('6. Worker Preflight Capability Verification', () => {
    test('validateWorkerPreflight executes and returns daemon cgroup capabilities', async () => {
      const result = await validateWorkerPreflight({ requireCgroups: false });
      expect(result).toBeDefined();
      expect(result.cgroupCaps).toBeDefined();
    });

    test('validateWorkerPreflight fails closed if cgroups required but missing on un-enforced daemon', async () => {
      const mockUnenforcedClient = {
        info: async () => ({
          CgroupDriver: 'none',
          CgroupVersion: '2',
          MemoryLimit: false,
          CPUShares: false,
          PidsLimit: false,
        }),
      };
      await expect(
        validateWorkerPreflight({ dockerClient: mockUnenforcedClient, requireCgroups: true })
      ).rejects.toThrow(/Execution daemon cgroup enforcement is required/i);
    });
  });
});
