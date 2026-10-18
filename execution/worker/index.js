const path = require('path');

// Load environment variables if running as a standalone process
try {
  require('dotenv').config({
    path: path.resolve(__dirname, '../../.env'),
  });
} catch (_) {
  // Ignore dotenv load errors in environments where .env is not present
}

const { Worker } = require('bullmq');
const executeCode = require('../engine/executeCode');
const {
  EXECUTION_QUEUE_NAME,
  DEFAULT_CONCURRENCY,
  parseRedisUrl,
} = require('../engine/queue');

// Redact credentials from connection URLs for safe logging (SEC-LOG-01)
function sanitizeRedisUrl(url = '') {
  if (typeof url !== 'string') return '';
  return url.replace(/(:\/\/)([^:@\s]+)?(?::([^@\s]+))?@/, (match, proto, user) => {
    return user ? `${proto}${user}:***@` : `${proto}:***@`;
  });
}

// Global singleton worker tracking to prevent duplicate workers
let activeWorker = null;
let isShuttingDown = false;

/**
 * Job processing function invoked for each queued BullMQ execution job.
 *
 * @param {Object} job - BullMQ Job instance
 * @returns {Promise<Object>} Execution result object
 */
async function processJob(job) {
  const { language, code, timeout, memory, roomId, userId } = job.data || {};
  const startTime = Date.now();

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
      executionTimeMs: Date.now() - startTime,
      status: 'failed',
      error: err.message,
    };
  }
}

/**
 * Starts the standalone BullMQ execution worker.
 * Idempotent: returns the existing active worker if already started.
 *
 * @param {Object} [options]
 * @param {string} [options.queueName] - Custom queue name (defaults to EXECUTION_QUEUE_NAME)
 * @param {string} [options.redisUrl] - Custom Redis URL
 * @param {Object} [options.connection] - Parsed connection options
 * @param {number} [options.concurrency] - Concurrency limit
 * @param {Object} [options.workerOptions] - Additional BullMQ Worker options
 * @returns {Worker} Initialized BullMQ Worker
 */
function startWorker(options = {}) {
  if (activeWorker && !activeWorker.closing && !activeWorker.closed) {
    return activeWorker;
  }

  isShuttingDown = false;

  const queueName = options.queueName || EXECUTION_QUEUE_NAME;
  const redisUrl = options.redisUrl || process.env.REDIS_URL || 'redis://localhost:6379';
  const concurrency = typeof options.concurrency === 'number'
    ? options.concurrency
    : (parseInt(process.env.EXECUTION_CONCURRENCY, 10) || DEFAULT_CONCURRENCY);

  const connection = options.connection || parseRedisUrl(redisUrl);

  const worker = new Worker(queueName, processJob, {
    connection,
    concurrency,
    ...(options.workerOptions || {}),
  });

  worker.on('ready', () => {
    const safeUrl = sanitizeRedisUrl(redisUrl);
    console.log(`[ExecutionWorker] Worker ready. Queue: "${queueName}", Concurrency: ${concurrency}, Redis: ${safeUrl}`);
  });

  worker.on('error', (err) => {
    console.error(`[ExecutionWorker] Worker connection error: ${err.message}`);
  });

  worker.on('failed', (job, err) => {
    const jobId = job ? job.id : 'unknown';
    console.error(`[ExecutionWorker] Job ${jobId} failed: ${err.message}`);
  });

  worker.on('completed', (job, result) => {
    const jobId = job ? job.id : 'unknown';
    const status = result && result.status ? result.status : 'completed';
    const duration = result && result.executionTimeMs ? `${result.executionTimeMs}ms` : '';
    console.log(`[ExecutionWorker] Job ${jobId} finished (${status}) ${duration}`);
  });

  activeWorker = worker;
  return worker;
}

/**
 * Stops the active worker cleanly.
 *
 * @param {boolean} [force=true]
 * @returns {Promise<void>}
 */
async function stopWorker(force = true) {
  if (!activeWorker) return;
  const worker = activeWorker;
  activeWorker = null;
  try {
    await worker.close(force);
  } catch (err) {
    // Avoid unhandled errors on double-close
  }
}

/**
 * Coordinates graceful process shutdown on SIGTERM / SIGINT signals.
 *
 * @param {string} signal
 * @returns {Promise<void>}
 */
async function shutdown(signal = 'SIGTERM') {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`[ExecutionWorker] Received ${signal}. Draining and shutting down cleanly...`);
  await stopWorker(true);
  console.log(`[ExecutionWorker] Teardown complete.`);

  if (require.main === module) {
    process.exit(0);
  }
}

/**
 * Runs preflight capability verification before the worker accepts jobs.
 * Fails closed if cgroup enforcement or runtime verification fails.
 *
 * @param {Object} [options]
 * @returns {Promise<{ cgroupCaps: Object }>}
 */
async function validateWorkerPreflight(options = {}) {
  const { getDockerClient } = require('../engine/executor');
  const { verifyCgroupCapabilities, verifyRuntimeAvailable } = require('../engine/dockerConfig');
  const sandboxConfig = require('../engine/sandboxConfig');

  const docker = options.dockerClient || getDockerClient();
  const cgroupCaps = await verifyCgroupCapabilities(docker, {
    requireCgroups: options.requireCgroups,
    executionProfile: options.executionProfile,
    nodeEnv: options.nodeEnv,
    allowUnenforcedCgroups: options.allowUnenforcedCgroups,
  });

  if (sandboxConfig.CONTAINER_RUNTIME) {
    await verifyRuntimeAvailable(docker, sandboxConfig.CONTAINER_RUNTIME);
  }

  if (!cgroupCaps.controllersEnforced) {
    console.warn(
      '[ExecutionWorker] WARNING: Connected to execution daemon without active kernel cgroup controller enforcement (driver: none). ' +
      'Per-runner CPU, memory, and PID limits are disabled. Using process timeouts and outer host boundaries only.'
    );
  } else {
    console.log(
      `[ExecutionWorker] Daemon advertises cgroup capabilities (driver: ${cgroupCaps.cgroupDriver}, version: ${cgroupCaps.cgroupVersion}); live enforcement qualification is still required.`
    );
  }

  return { cgroupCaps };
}

// Handle termination signals and startup when invoked as the main CLI entrypoint
if (require.main === module) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  (async () => {
    try {
      await validateWorkerPreflight();
      startWorker();
    } catch (err) {
      console.error(`[ExecutionWorker] Fatal startup error: ${err.message}`);
      process.exit(1);
    }
  })();
}

module.exports = {
  startWorker,
  stopWorker,
  shutdown,
  processJob,
  sanitizeRedisUrl,
  validateWorkerPreflight,
  getWorker: () => activeWorker,
};
