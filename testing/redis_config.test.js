const {
  buildRedisUrl,
  resolveRedisTestConfig,
  bootstrapRedisTestEnv,
  verifyRedisPreflight,
  parseRedisUrl,
  sanitizeRedisUrl,
} = require('./redisTestHelper');

describe('Redis Test Configuration and Bootstrap Suite (Phase 2)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('1. URL Construction and Encoding (buildRedisUrl)', () => {
    test('constructs standard URL with password targeting 127.0.0.1:6379/0', () => {
      const url = buildRedisUrl({ password: 'test-password-123' });
      expect(url).toBe('redis://:test-password-123@127.0.0.1:6379/0');

      const parsed = parseRedisUrl(url);
      expect(parsed.host).toBe('127.0.0.1');
      expect(parsed.port).toBe(6379);
      expect(parsed.password).toBe('test-password-123');
      expect(parsed.username).toBeUndefined();
      expect(parsed.db).toBe(0);
    });

    test('correctly encodes password containing reserved URL characters', () => {
      const complexPassword = 'p@ss:w/ord#?%&=!';
      const url = buildRedisUrl({ password: complexPassword });

      expect(url).toBe(
        `redis://:${encodeURIComponent(complexPassword)}@127.0.0.1:6379/0`
      );

      // Verify round-trip decoding through parseRedisUrl / new URL
      const parsed = parseRedisUrl(url);
      expect(parsed.password).toBe(complexPassword);
      expect(parsed.host).toBe('127.0.0.1');
    });

    test('handles optional Redis username correctly', () => {
      const url = buildRedisUrl({
        username: 'alice_user',
        password: 'secure-token-abc',
      });
      expect(url).toBe('redis://alice_user:secure-token-abc@127.0.0.1:6379/0');

      const parsed = parseRedisUrl(url);
      expect(parsed.username).toBe('alice_user');
      expect(parsed.password).toBe('secure-token-abc');
      expect(parsed.host).toBe('127.0.0.1');
    });

    test('normalizes Docker-internal hostname "redis" to "127.0.0.1"', () => {
      const url = buildRedisUrl({
        host: 'redis',
        port: 6379,
        password: 'my-redis-pass',
      });
      expect(url).toBe('redis://:my-redis-pass@127.0.0.1:6379/0');
    });

    test('respects custom port, db, and host when provided', () => {
      const url = buildRedisUrl({
        host: '10.0.0.5',
        port: 6380,
        db: 2,
        password: 'pass',
      });
      expect(url).toBe('redis://:pass@10.0.0.5:6380/2');
    });
  });

  describe('2. Safe Logging and Redaction (sanitizeRedisUrl)', () => {
    test('redacts password from URL without username', () => {
      const sanitized = sanitizeRedisUrl('redis://:supersecret@127.0.0.1:6379/0');
      expect(sanitized).toBe('redis://:***@127.0.0.1:6379/0');
      expect(sanitized).not.toContain('supersecret');
    });

    test('redacts password while preserving username', () => {
      const sanitized = sanitizeRedisUrl('redis://bob:supersecret@127.0.0.1:6379/0');
      expect(sanitized).toBe('redis://bob:***@127.0.0.1:6379/0');
      expect(sanitized).not.toContain('supersecret');
    });

    test('leaves unauthenticated URL unchanged', () => {
      const sanitized = sanitizeRedisUrl('redis://127.0.0.1:6379/0');
      expect(sanitized).toBe('redis://127.0.0.1:6379/0');
    });
  });

  describe('3. Configuration Precedence (resolveRedisTestConfig)', () => {
    test('prefers explicit process.env.REDIS_URL over all other sources', () => {
      const mockFs = {
        existsSync: () => true,
        readFileSync: (file) =>
          file.includes('infrastructure')
            ? 'REDIS_PASSWORD=infra-pwd'
            : 'REDIS_PASSWORD=root-pwd',
      };

      const result = resolveRedisTestConfig({
        env: {
          REDIS_URL: 'redis://custom-env-host:6379/3',
          REDIS_PASSWORD: 'env-password',
        },
        fs: mockFs,
      });

      expect(result.redisUrl).toBe('redis://custom-env-host:6379/3');
      expect(result.source).toBe('process.env.REDIS_URL');
    });

    test('preserves intentionally unauthenticated explicit process.env.REDIS_URL', () => {
      const mockFs = {
        existsSync: () => true,
        readFileSync: () => 'REDIS_PASSWORD=file-pwd',
      };

      const result = resolveRedisTestConfig({
        env: {
          REDIS_URL: 'redis://localhost:6379',
        },
        fs: mockFs,
      });

      expect(result.redisUrl).toBe('redis://localhost:6379');
      expect(result.source).toBe('process.env.REDIS_URL');
    });

    test('prefers explicit process.env.REDIS_PASSWORD when REDIS_URL is not provided', () => {
      const mockFs = {
        existsSync: () => true,
        readFileSync: () => 'REDIS_PASSWORD=file-pwd',
      };

      const result = resolveRedisTestConfig({
        env: {
          REDIS_PASSWORD: 'direct-env-pass',
          REDIS_USER: 'env-user',
        },
        fs: mockFs,
      });

      expect(result.redisUrl).toBe('redis://env-user:direct-env-pass@127.0.0.1:6379/0');
      expect(result.source).toBe('process.env.REDIS_PASSWORD');
    });

    test('gives root .env precedence over infrastructure/.env when both provide configuration', () => {
      const mockFs = {
        existsSync: () => true,
        readFileSync: (filePath) => {
          if (filePath.endsWith('infrastructure\\.env') || filePath.endsWith('infrastructure/.env')) {
            return 'REDIS_PASSWORD=infra-level-pwd\n';
          }
          return 'REDIS_PASSWORD=root-level-pwd\n';
        },
      };

      const result = resolveRedisTestConfig({
        env: {},
        fs: mockFs,
      });

      expect(result.redisUrl).toBe('redis://:root-level-pwd@127.0.0.1:6379/0');
      expect(result.source).toBe('.env');
    });

    test('discovers credentials from infrastructure/.env when root .env has no Redis configuration', () => {
      const mockFs = {
        existsSync: (filePath) => true,
        readFileSync: (filePath) => {
          if (filePath.endsWith('infrastructure\\.env') || filePath.endsWith('infrastructure/.env')) {
            return 'REDIS_PASSWORD=discovered-infra-pass\n';
          }
          // Root .env has non-Redis variables only
          return 'PORT=5000\nNODE_ENV=development\n';
        },
      };

      const result = resolveRedisTestConfig({
        env: {},
        fs: mockFs,
      });

      expect(result.redisUrl).toBe('redis://:discovered-infra-pass@127.0.0.1:6379/0');
      expect(result.source).toBe('infrastructure/.env');
    });

    test('fails closed with actionable error when no Redis configuration exists anywhere', () => {
      const mockFs = {
        existsSync: () => false,
        readFileSync: () => '',
      };

      expect(() => {
        resolveRedisTestConfig({
          env: {},
          fs: mockFs,
        });
      }).toThrow(/No Redis test configuration found/i);
    });

    test('does not silently fall back to unauthenticated Redis when config is empty', () => {
      const mockFs = {
        existsSync: () => true,
        readFileSync: () => 'PORT=5000\n',
      };

      expect(() => {
        resolveRedisTestConfig({
          env: {},
          fs: mockFs,
        });
      }).toThrow(/Falling back silently to unauthenticated localhost Redis is disabled/i);
    });
  });

  describe('4. Environment Bootstrap (bootstrapRedisTestEnv)', () => {
    test('populates process.env.REDIS_URL on successful resolution', () => {
      delete process.env.REDIS_URL;
      delete process.env.REDIS_PASSWORD;

      const mockFs = {
        existsSync: () => true,
        readFileSync: () => 'REDIS_PASSWORD=bootstrap-secret\n',
      };

      const config = bootstrapRedisTestEnv({
        env: {},
        fs: mockFs,
      });

      expect(config.redisUrl).toBe('redis://:bootstrap-secret@127.0.0.1:6379/0');
      expect(process.env.REDIS_URL).toBe('redis://:bootstrap-secret@127.0.0.1:6379/0');
    });

    test('records bootstrap error without throwing by default when throwOnError is false', () => {
      const mockFs = {
        existsSync: () => false,
      };

      const result = bootstrapRedisTestEnv({
        env: {},
        fs: mockFs,
        throwOnError: false,
      });

      expect(result.error).toBeDefined();
      expect(result.error.message).toMatch(/No Redis test configuration found/i);
    });
  });

  describe('5. Preflight Connection Probe (verifyRedisPreflight)', () => {
    test('fails fast and sanitizes output on authentication failure without leaking credentials', async () => {
      // Connect to local Redis with an intentionally incorrect password
      const invalidUrl = 'redis://:deliberately-wrong-pass-xyz@127.0.0.1:6379/0';

      await expect(
        verifyRedisPreflight({ redisUrl: invalidUrl, timeoutMs: 1500 })
      ).rejects.toThrow();

      try {
        await verifyRedisPreflight({ redisUrl: invalidUrl, timeoutMs: 1500 });
      } catch (err) {
        expect(err.message).toContain('Redis preflight check failed');
        expect(err.message).toContain(':***@');
        expect(err.message).not.toContain('deliberately-wrong-pass-xyz');
      }
    });

    test('fails fast and cleans up connection when targeting unreachable host/port', async () => {
      // Port 6399 is not listening
      const unreachableUrl = 'redis://127.0.0.1:6399/0';

      const start = Date.now();
      await expect(
        verifyRedisPreflight({ redisUrl: unreachableUrl, timeoutMs: 1000 })
      ).rejects.toThrow(/ECONNREFUSED|timed out|Connection is closed/i);

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(3000);
    });

    test('succeeds against healthy local Redis using discovered configuration', async () => {
      await expect(verifyRedisPreflight()).resolves.toBeUndefined();
    });
  });
});
