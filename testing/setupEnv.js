/**
 * Jest setup file executed before test modules are imported.
 * Discovers and bootstraps authenticated local Redis configuration for tests.
 */
const { bootstrapRedisTestEnv } = require('./redisTestHelper');

bootstrapRedisTestEnv();
