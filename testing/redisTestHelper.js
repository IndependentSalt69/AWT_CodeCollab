const path = require('path');
const dotenv = require('dotenv');
const IORedis = require('ioredis');

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
 * Redacts credentials from connection URLs for safe logging (SEC-LOG-01).
 */
function sanitizeRedisUrl(url = '') {
  if (typeof url !== 'string') return '';
  return url.replace(/(:\/\/)([^:@\s]+)?(?::([^@\s]+))?@/, (match, proto, user) => {
    return user ? `${proto}${user}:***@` : `${proto}:***@`;
  });
}

/**
 * Constructs a Redis connection URL from individual parameters.
 * Target host defaults to '127.0.0.1' and normalizes Docker-internal hostnames like 'redis'.
 * Percent-encodes username and password.
 *
 * @param {Object} options
 * @param {string} [options.host='127.0.0.1']
 * @param {number|string} [options.port=6379]
 * @param {string} [options.username='']
 * @param {string} [options.password='']
 * @param {number|string} [options.db=0]
 * @returns {string} Fully formed Redis URL
 */
function buildRedisUrl(options = {}) {
  const rawHost = options.host || '127.0.0.1';
  const host = rawHost === 'redis' ? '127.0.0.1' : rawHost;
  const port = typeof options.port === 'number' ? options.port : (parseInt(options.port, 10) || 6379);
  const db = typeof options.db === 'number' ? options.db : (parseInt(options.db, 10) || 0);

  const username = options.username ? encodeURIComponent(options.username) : '';
  const password = options.password ? encodeURIComponent(options.password) : '';

  let authPart = '';
  if (username && password) {
    authPart = `${username}:${password}@`;
  } else if (password) {
    authPart = `:${password}@`;
  } else if (username) {
    authPart = `${username}@`;
  }

  return `redis://${authPart}${host}:${port}/${db}`;
}

/**
 * Resolves Redis test configuration following strict precedence:
 * 1. Explicit process.env.REDIS_URL
 * 2. Explicit process.env.REDIS_PASSWORD
 * 3. Root .env (REDIS_URL or REDIS_PASSWORD)
 * 4. infrastructure/.env (REDIS_URL or REDIS_PASSWORD)
 * 5. Fails closed with an actionable error if no configuration is found.
 *
 * @param {Object} [options]
 * @param {Object} [options.env=process.env]
 * @param {string} [options.rootDir]
 * @param {Object} [options.fs]
 * @returns {{ redisUrl: string, source: string }}
 */
function resolveRedisTestConfig(options = {}) {
  const env = options.env || process.env;
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  const fileSystem = options.fs || require('fs');

  // 1. Explicit REDIS_URL in process environment (preserve as-is, even if unauthenticated)
  if (typeof env.REDIS_URL === 'string' && env.REDIS_URL.trim() !== '') {
    return {
      redisUrl: env.REDIS_URL.trim(),
      source: 'process.env.REDIS_URL',
    };
  }

  // 2. Explicit REDIS_PASSWORD in process environment
  if (typeof env.REDIS_PASSWORD === 'string' && env.REDIS_PASSWORD.trim() !== '') {
    const rawHost = env.REDIS_HOST || '127.0.0.1';
    const host = rawHost === 'redis' ? '127.0.0.1' : rawHost;
    const port = parseInt(env.REDIS_PORT, 10) || 6379;
    const username = env.REDIS_USER || env.REDIS_USERNAME || '';
    const password = env.REDIS_PASSWORD;
    const db = parseInt(env.REDIS_DB, 10) || 0;

    return {
      redisUrl: buildRedisUrl({ host, port, username, password, db }),
      source: 'process.env.REDIS_PASSWORD',
    };
  }

  // Helper to read and parse .env files silently without logging
  const readEnvFile = (filePath) => {
    try {
      if (fileSystem.existsSync(filePath)) {
        const content = fileSystem.readFileSync(filePath, 'utf8');
        return dotenv.parse(content);
      }
    } catch (_) {
      // Ignore read errors
    }
    return null;
  };

  // 3. Inspect root .env
  const rootEnvPath = path.join(rootDir, '.env');
  const rootEnv = readEnvFile(rootEnvPath);
  if (rootEnv) {
    if (typeof rootEnv.REDIS_URL === 'string' && rootEnv.REDIS_URL.trim() !== '') {
      return {
        redisUrl: rootEnv.REDIS_URL.trim(),
        source: '.env',
      };
    }
    if (typeof rootEnv.REDIS_PASSWORD === 'string' && rootEnv.REDIS_PASSWORD.trim() !== '') {
      const rawHost = rootEnv.REDIS_HOST || '127.0.0.1';
      const host = rawHost === 'redis' ? '127.0.0.1' : rawHost;
      const port = parseInt(rootEnv.REDIS_PORT, 10) || 6379;
      const username = rootEnv.REDIS_USER || rootEnv.REDIS_USERNAME || '';
      const password = rootEnv.REDIS_PASSWORD;
      const db = parseInt(rootEnv.REDIS_DB, 10) || 0;

      return {
        redisUrl: buildRedisUrl({ host, port, username, password, db }),
        source: '.env',
      };
    }
  }

  // 4. Inspect infrastructure/.env
  const infraEnvPath = path.join(rootDir, 'infrastructure', '.env');
  const infraEnv = readEnvFile(infraEnvPath);
  if (infraEnv) {
    if (typeof infraEnv.REDIS_URL === 'string' && infraEnv.REDIS_URL.trim() !== '') {
      return {
        redisUrl: infraEnv.REDIS_URL.trim(),
        source: 'infrastructure/.env',
      };
    }
    if (typeof infraEnv.REDIS_PASSWORD === 'string' && infraEnv.REDIS_PASSWORD.trim() !== '') {
      const rawHost = infraEnv.REDIS_HOST || '127.0.0.1';
      const host = rawHost === 'redis' ? '127.0.0.1' : rawHost;
      const port = parseInt(infraEnv.REDIS_PORT, 10) || 6379;
      const username = infraEnv.REDIS_USER || infraEnv.REDIS_USERNAME || '';
      const password = infraEnv.REDIS_PASSWORD;
      const db = parseInt(infraEnv.REDIS_DB, 10) || 0;

      return {
        redisUrl: buildRedisUrl({ host, port, username, password, db }),
        source: 'infrastructure/.env',
      };
    }
  }

  // 5. Fail closed with actionable error if no configuration is found
  throw new Error(
    'No Redis test configuration found. ' +
    'Please set REDIS_URL or REDIS_PASSWORD in process environment, root .env, or infrastructure/.env. ' +
    'Falling back silently to unauthenticated localhost Redis is disabled.'
  );
}

let lastBootstrapError = null;

/**
 * Bootstraps the test environment by resolving Redis test configuration
 * and populating process.env.REDIS_URL before modules load the queue singleton.
 *
 * @param {Object} [options]
 * @param {boolean} [options.throwOnError=false]
 * @returns {{ redisUrl?: string, error?: Error, source?: string }}
 */
function bootstrapRedisTestEnv(options = {}) {
  try {
    const config = resolveRedisTestConfig(options);
    process.env.REDIS_URL = config.redisUrl;
    lastBootstrapError = null;
    return config;
  } catch (err) {
    lastBootstrapError = err;
    if (options.throwOnError) {
      throw err;
    }
    return { error: err };
  }
}

function getBootstrapError() {
  return lastBootstrapError;
}

/**
 * Fast-failing preflight check for test suites requiring a live, authenticated Redis instance.
 * Checks connection and PONG response with a strict timeout and no retry loop.
 * Cleans up connection immediately in all cases.
 *
 * @param {Object} [options]
 * @param {string} [options.redisUrl]
 * @param {number} [options.timeoutMs=2000]
 * @returns {Promise<void>} Resolves if Redis is reachable and authenticated; throws actionable error otherwise.
 */
async function verifyRedisPreflight(options = {}) {
  const timeoutMs = options.timeoutMs || 2000;
  let redisUrl = options.redisUrl || process.env.REDIS_URL;

  if (!redisUrl) {
    const bErr = getBootstrapError();
    if (bErr) {
      throw new Error(`Redis preflight check failed: ${bErr.message}`);
    }
    try {
      const resolved = resolveRedisTestConfig(options);
      redisUrl = resolved.redisUrl;
    } catch (err) {
      throw new Error(`Redis preflight check failed: ${err.message}`);
    }
  }

  const connectionOptions = parseRedisUrl(redisUrl);
  const safeUrl = sanitizeRedisUrl(redisUrl);

  const redis = new IORedis({
    ...connectionOptions,
    lazyConnect: true,
    connectTimeout: timeoutMs,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
  });

  redis.on('error', () => {
    // Suppress unhandled EventEmitter errors during preflight probe
  });

  let timeoutHandle;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Connection timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    await Promise.race([
      redis.connect(),
      timeoutPromise,
    ]);

    const pong = await redis.ping();
    if (pong !== 'PONG') {
      throw new Error(`Unexpected Redis response: "${pong}"`);
    }
  } catch (err) {
    const rawMsg = err && err.message ? err.message : String(err);
    const sanitizedMsg = rawMsg.replace(/(:\/\/)([^:@\s]+)?(?::([^@\s]+))?@/g, '$1***:***@');
    throw new Error(
      `Redis preflight check failed for ${safeUrl}: ${sanitizedMsg}. ` +
      `Ensure Redis is running and credentials in environment or .env are valid.`
    );
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    try {
      redis.disconnect(false);
    } catch (_) {
      // Disconnect cleanly
    }
  }
}

module.exports = {
  buildRedisUrl,
  resolveRedisTestConfig,
  bootstrapRedisTestEnv,
  getBootstrapError,
  verifyRedisPreflight,
  parseRedisUrl,
  sanitizeRedisUrl,
};
