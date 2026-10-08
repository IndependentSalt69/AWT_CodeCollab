const { ExecutionQueue, parseRedisUrl, DEFAULT_CONCURRENCY, EXECUTION_QUEUE_NAME } = require('../../execution/engine/queue');
const sandboxConfig = require('../../execution/engine/sandboxConfig');

describe('Redis + BullMQ Execution Queue Tests (M0.5c)', () => {
  let executionQueue;
  const testQueueName = `test-exec-queue-${Date.now()}`;

  beforeAll(async () => {
    executionQueue = new ExecutionQueue({
      queueName: testQueueName,
      concurrency: 2,
    });
    // Start default worker for this test queue
    executionQueue.startWorker();
  });

  afterAll(async () => {
    if (executionQueue) {
      await executionQueue.close();
    }
  });

  // Give container + queue processing sufficient test timeout
  jest.setTimeout(30000);

  describe('1. Redis Connectivity and URL Parsing', () => {
    test('should connect to Redis and return pong from ping()', async () => {
      const isHealthy = await executionQueue.ping();
      expect(isHealthy).toBe(true);
    });

    test('should parse standard and customized REDIS_URL strings', () => {
      const standard = parseRedisUrl('redis://localhost:6379');
      expect(standard.host).toBe('localhost');
      expect(standard.port).toBe(6379);
      expect(standard.db).toBe(0);

      const custom = parseRedisUrl('redis://:secret@127.0.0.1:6380/2');
      expect(custom.host).toBe('127.0.0.1');
      expect(custom.port).toBe(6380);
      expect(custom.password).toBe('secret');
      expect(custom.db).toBe(2);

      const invalid = parseRedisUrl('not-a-valid-url');
      expect(invalid.host).toBe('localhost');
      expect(invalid.port).toBe(6379);
    });
  });

  describe('2. Enqueue and Process Execution Jobs', () => {
    test('should enqueue a Python job and propagate completed execution result', async () => {
      const result = await executionQueue.execute({
        language: 'python',
        code: 'print("Hello from BullMQ Execution Queue!")',
      });

      expect(result.status).toBe('completed');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('Hello from BullMQ Execution Queue!');
      expect(result.stderr).toBe('');
      expect(result.executionTimeMs).toBeGreaterThan(0);
    });

    test('should process calculations and multi-line output via queue', async () => {
      const result = await executionQueue.execute({
        language: 'python',
        code: 'for i in range(4):\n    print(i * 5)',
      });

      expect(result.status).toBe('completed');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim().split(/\r?\n/)).toEqual(['0', '5', '10', '15']);
      expect(result.stderr).toBe('');
    });
  });

  describe('3. Worker Resiliency and Failure Representation', () => {
    test('should record runtime errors as failed status without crashing the worker', async () => {
      const failResult = await executionQueue.execute({
        language: 'python',
        code: 'raise RuntimeError("Deliberate queue worker test error")',
      });

      expect(failResult.status).toBe('failed');
      expect(failResult.exitCode).not.toBe(0);
      expect(failResult.stderr).toContain('RuntimeError: Deliberate queue worker test error');

      // Verify worker remains healthy by executing another job immediately
      const recoverResult = await executionQueue.execute({
        language: 'python',
        code: 'print("Worker is still alive and processing")',
      });

      expect(recoverResult.status).toBe('completed');
      expect(recoverResult.exitCode).toBe(0);
      expect(recoverResult.stdout.trim()).toBe('Worker is still alive and processing');
    });

    test('should record syntax errors gracefully as failed status', async () => {
      const syntaxResult = await executionQueue.execute({
        language: 'python',
        code: 'def broken_function(',
      });

      expect(syntaxResult.status).toBe('failed');
      expect(syntaxResult.exitCode).not.toBe(0);
      expect(syntaxResult.stderr).toContain('SyntaxError');
    });

    test('should enforce execution timeout and return timeout status via queue', async () => {
      const timeoutResult = await executionQueue.execute({
        language: 'python',
        code: 'import time\ntime.sleep(10)',
        timeout: 1200,
      });

      expect(timeoutResult.status).toBe('timeout');
      expect(timeoutResult.exitCode).toBe(124);
      expect(timeoutResult.stderr).toContain('Execution timed out after 1200ms');
    });
  });

  describe('4. Input Validation and Unsupported Language Rejection', () => {
    test('should reject add() when language or code is missing', async () => {
      await expect(executionQueue.add()).rejects.toThrow('Language and code are required');
      await expect(executionQueue.add({})).rejects.toThrow('Language and code are required');
      await expect(executionQueue.add({ language: 'python' })).rejects.toThrow('Language and code are required');
      await expect(executionQueue.add({ code: 'print(1)' })).rejects.toThrow('Language and code are required');
    });

    test('should process unsupported language jobs into structured failure result', async () => {
      const result = await executionQueue.execute({
        language: 'cpp',
        code: 'int main() { return 0; }',
      });

      expect(result.status).toBe('failed');
      expect(result.stderr).toContain('Unsupported execution language: cpp');
    });
  });

  describe('5. Concurrency and Bounded Execution Control', () => {
    test('should respect configured concurrency limit (max 2 active simultaneous jobs)', async () => {
      const concurrentQueueName = `test-concurrency-queue-${Date.now()}`;
      let activeJobsCount = 0;
      let maxObservedActive = 0;

      const concurrentQueue = new ExecutionQueue({
        queueName: concurrentQueueName,
        concurrency: 2,
      });

      // Start custom processor that tracks active concurrency
      concurrentQueue.startWorker(async (job) => {
        activeJobsCount++;
        maxObservedActive = Math.max(maxObservedActive, activeJobsCount);

        // Sleep to simulate active execution overlap
        await new Promise((r) => setTimeout(r, 200));

        activeJobsCount--;
        return { ok: true, id: job.id };
      });

      try {
        // Enqueue 4 jobs simultaneously
        const jobPromises = [
          concurrentQueue.execute({ language: 'python', code: 'print(1)' }),
          concurrentQueue.execute({ language: 'python', code: 'print(2)' }),
          concurrentQueue.execute({ language: 'python', code: 'print(3)' }),
          concurrentQueue.execute({ language: 'python', code: 'print(4)' }),
        ];

        const results = await Promise.all(jobPromises);
        expect(results.length).toBe(4);
        // Peak active count must never exceed configured concurrency (2)
        expect(maxObservedActive).toBeLessThanOrEqual(2);
      } finally {
        await concurrentQueue.close();
      }
    });
  });

  describe('6. Redis Unavailable Error Handling', () => {
    test('should return false from ping() when Redis is unreachable', async () => {
      const offlineQueue = new ExecutionQueue({
        queueName: 'offline-queue-ping',
        connection: {
          host: '127.0.0.1',
          port: 59999, // Unreachable port
        },
      });

      const isHealthy = await offlineQueue.ping();
      expect(isHealthy).toBe(false);
      await offlineQueue.close();
    });
  });

});
