const { Queue, Worker, QueueEvents } = require('bullmq');
const IORedis = require('ioredis');
const executeCode = require('./executeCode');
const sandboxConfig = require('./sandboxConfig');

const EXECUTION_QUEUE_NAME = 'codecollab-execution-queue';
const DEFAULT_CONCURRENCY = 2; // Bounded concurrency targeting 2-4 simultaneous executions

/**
 * Parses a Redis connection string into connection options suitable for ioredis/BullMQ.
 */
function parseRedisUrl(redisUrl = process.env.REDIS_URL || 'redis://localhost:6379') {
  try {
    const parsed = new URL(redisUrl);
    return {
      host: parsed.hostname || 'localhost',
      port: parseInt(parsed.port, 10) || 6379,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      db: parsed.pathname && parsed.pathname.length > 1 ? parseInt(parsed.pathname.slice(1), 10) || 0 : 0,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
  } catch (_) {
    return {
      host: 'localhost',
      port: 6379,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
  }
}

/**
 * ExecutionQueue coordinates asynchronous code execution runs via Redis + BullMQ.
 */
class ExecutionQueue {
  constructor(options = {}) {
    this.queueName = options.queueName || EXECUTION_QUEUE_NAME;
    this.redisUrl = options.redisUrl || process.env.REDIS_URL || 'redis://localhost:6379';
    this.concurrency = typeof options.concurrency === 'number'
      ? options.concurrency
      : (parseInt(process.env.EXECUTION_CONCURRENCY, 10) || DEFAULT_CONCURRENCY);

    this.connectionOptions = options.connection || parseRedisUrl(this.redisUrl);

    this._queue = null;
    this._worker = null;
    this._queueEvents = null;
    this._isClosed = false;
  }

  /**
   * Initializes and returns the BullMQ Queue instance.
   */
  getQueue() {
    if (this._isClosed) {
      throw new Error('ExecutionQueue is closed');
    }
    if (!this._queue) {
      this._queue = new Queue(this.queueName, {
        connection: this.connectionOptions,
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 200,
          attempts: 1,
        },
      });

      this._queue.on('error', () => {
        // Prevent unhandled error event crashes
      });
    }
    return this._queue;
  }

  /**
   * Initializes and returns the BullMQ QueueEvents instance.
   */
  getQueueEvents() {
    if (this._isClosed) {
      throw new Error('ExecutionQueue is closed');
    }
    if (!this._queueEvents) {
      this._queueEvents = new QueueEvents(this.queueName, {
        connection: this.connectionOptions,
      });

      this._queueEvents.on('error', () => {
        // Prevent unhandled error event crashes
      });
    }
    return this._queueEvents;
  }

  /**
   * Starts the BullMQ Worker to process execution jobs.
   */
  startWorker(processor = null, workerOptions = {}) {
    if (this._isClosed) {
      throw new Error('ExecutionQueue is closed');
    }
    if (this._worker) {
      return this._worker;
    }

    const concurrency = typeof workerOptions.concurrency === 'number'
      ? workerOptions.concurrency
      : this.concurrency;

    const jobProcessor = processor || (async (job) => {
      const { language, code, timeout, memory } = job.data;
      try {
        const result = await executeCode({
          language,
          code,
          timeout,
          memory,
        });
        return result;
      } catch (err) {
        return {
          stdout: '',
          stderr: err.message || 'Execution error',
          exitCode: 1,
          executionTimeMs: 0,
          status: 'failed',
          error: err.message,
        };
      }
    });

    this._worker = new Worker(this.queueName, jobProcessor, {
      connection: this.connectionOptions,
      concurrency,
      ...workerOptions,
    });

    this._worker.on('error', () => {
      // Prevent unhandled error event crashes
    });

    return this._worker;
  }

  /**
   * Adds an execution job to the queue.
   *
   * @param {Object} jobSpec
   * @param {string} jobSpec.language - 'python'
   * @param {string} jobSpec.code - Submitted source code
   * @param {number} [jobSpec.timeout] - Timeout in milliseconds
   * @param {string} [jobSpec.memory] - Memory limit
   * @param {Object} [opts] - BullMQ job options
   * @returns {Promise<Job>} BullMQ Job instance
   */
  async add(jobSpec, opts = {}) {
    if (!jobSpec || typeof jobSpec !== 'object') {
      throw new Error('Language and code are required for execution');
    }

    const { language, code, timeout = sandboxConfig.timeoutMs, memory = sandboxConfig.memory, roomId, userId } = jobSpec;

    if (!language || !code) {
      throw new Error('Language and code are required for execution');
    }

    const queue = this.getQueue();
    const payload = {
      language,
      code,
      timeout,
      memory,
      roomId: roomId || null,
      userId: userId || null,
      enqueuedAt: Date.now(),
    };

    return await queue.add('executeCode', payload, opts);
  }

  /**
   * Enqueues a job and waits for its execution result.
   */
  async execute(jobSpec, timeoutMs = 30000) {
    const job = await this.add(jobSpec);
    const queueEvents = this.getQueueEvents();
    return await job.waitUntilFinished(queueEvents, timeoutMs);
  }

  /**
   * Retrieves a job by ID.
   */
  async getJob(jobId) {
    const queue = this.getQueue();
    return await queue.getJob(jobId);
  }

  /**
   * Retrieves queue counts.
   */
  async getCounts() {
    const queue = this.getQueue();
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ]);
    return { waiting, active, completed, failed, delayed };
  }

  /**
   * Returns waiting job count.
   */
  async getLength() {
    const queue = this.getQueue();
    return await queue.getWaitingCount();
  }

  /**
   * Tests Redis connection health.
   */
  async ping() {
    const redis = new IORedis({
      ...this.connectionOptions,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      retryStrategy: () => null,
    });

    redis.on('error', () => {
      // Prevent unhandled error event crashes during ping check
    });

    try {
      const pong = await redis.ping();
      return pong === 'PONG';
    } catch (_) {
      return false;
    } finally {
      redis.disconnect();
    }
  }



  /**
   * Closes all active queue, worker, and event listener connections.
   */
  async close(force = true) {
    this._isClosed = true;
    if (this._worker) {
      await this._worker.close(force);
      this._worker = null;
    }
    if (this._queueEvents) {
      await this._queueEvents.close();
      this._queueEvents = null;
    }
    if (this._queue) {
      await this._queue.close();
      this._queue = null;
    }
  }



}

// Singleton default instance
const defaultQueue = new ExecutionQueue();

module.exports = defaultQueue;
module.exports.ExecutionQueue = ExecutionQueue;
module.exports.parseRedisUrl = parseRedisUrl;
module.exports.EXECUTION_QUEUE_NAME = EXECUTION_QUEUE_NAME;
module.exports.DEFAULT_CONCURRENCY = DEFAULT_CONCURRENCY;

