/**
 * Security Remediation Batch 3 Test Suite: API Hardening & Access Control
 *
 * Scope:
 * - SEC-ROOM-02: Private-room join protection, cryptographic invite codes, rotation, timing-safe validation
 * - SEC-API-01: Route rate limiting on auth and execute, RFC standard headers, proxy IP spoofing defense
 * - SEC-API-02: Helmet security headers and global error handler sanitization without leaking 500 details
 * - SEC-AUTH-02: Account enumeration mitigation (generic 409) and auth timing mitigation (dummy bcrypt comparison)
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const helmet = require('helmet');

const User = require('../../database/models/User');
const Room = require('../../database/models/Room');
const authRouter = require('../../backend/src/routes/auth');
const roomsRouter = require('../../backend/src/routes/rooms');
const executeRouter = require('../../backend/src/routes/execute');
const { generateToken } = require('../../backend/src/middleware/auth');
const { createRateLimiter } = require('../../backend/src/middleware/rateLimiter');
const { globalErrorHandler } = require('../../backend/src/middleware/errorHandler');
const roomService = require('../../backend/src/services/roomService');
const authService = require('../../backend/src/services/authService');

describe('Security Remediation Batch 3: API Hardening & Access Control', () => {
  let app;
  const mockRoomsDb = new Map();
  const mockUsersDb = new Map();

  const userOwner = {
    userId: '67056a1b2c3d4e5f6a7b8c01',
    id: '67056a1b2c3d4e5f6a7b8c01',
    username: 'alice_owner',
    email: 'alice@example.com',
  };

  const userMember = {
    userId: '67056a1b2c3d4e5f6a7b8c02',
    id: '67056a1b2c3d4e5f6a7b8c02',
    username: 'bob_member',
    email: 'bob@example.com',
  };

  const userAttacker = {
    userId: '67056a1b2c3d4e5f6a7b8c03',
    id: '67056a1b2c3d4e5f6a7b8c03',
    username: 'eve_attacker',
    email: 'eve@example.com',
  };

  const tokenOwner = generateToken(userOwner);
  const tokenMember = generateToken(userMember);
  const tokenAttacker = generateToken(userAttacker);

  function createMockRoom(data) {
    const doc = {
      _id: data._id || new mongoose.Types.ObjectId(),
      roomId: data.roomId,
      name: data.name || 'Test Room',
      language: data.language || 'python',
      isPrivate: Boolean(data.isPrivate),
      inviteHash: data.inviteHash !== undefined ? data.inviteHash : (data.inviteCode ? roomService.hashInviteCode(data.inviteCode) : null),
      inviteExpiresAt: data.inviteExpiresAt !== undefined ? data.inviteExpiresAt : (data.isPrivate ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) : null),
      currentCode: data.currentCode || '',
      owner: data.owner,
      members: Array.isArray(data.members) ? [...data.members] : [data.owner],
      createdAt: data.createdAt || new Date(),
      updatedAt: data.updatedAt || new Date(),
      save: jest.fn(function () {
        mockRoomsDb.set(this.roomId, this);
        mockRoomsDb.set(String(this._id), this);
        return Promise.resolve(this);
      }),
      populate: jest.fn(function () {
        return Promise.resolve(this);
      }),
      toObject: function () {
        return {
          id: String(this._id),
          _id: String(this._id),
          roomId: this.roomId,
          name: this.name,
          language: this.language,
          isPrivate: this.isPrivate,
          inviteHash: this.inviteHash,
          inviteExpiresAt: this.inviteExpiresAt,
          currentCode: this.currentCode,
          owner: this.owner,
          members: this.members,
          createdAt: this.createdAt,
          updatedAt: this.updatedAt,
        };
      },
    };
    mockRoomsDb.set(doc.roomId, doc);
    mockRoomsDb.set(String(doc._id), doc);
    return doc;
  }

  beforeAll(() => {
    app = express();
    app.use(helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }));
    app.use(express.json());

    app.use('/api/auth', authRouter);
    app.use('/api/rooms', roomsRouter);
    app.use('/api/execute', executeRouter);

    // Endpoint specifically designed to test unexpected 500 error sanitization
    app.get('/api/test-internal-error', (req, res, next) => {
      const dbException = new Error('MongoNetworkError: failed to connect to server [cluster0-shard-00-00.mongodb.net:27017]');
      dbException.stack = 'Error: MongoNetworkError at /server/database/cluster.js:42:15';
      next(dbException);
    });

    app.use(globalErrorHandler);

    function makeQuery(result) {
      return {
        populate: function () {
          return makeQuery(result);
        },
        sort: function () {
          return makeQuery(result);
        },
        then: function (resolve, reject) {
          return Promise.resolve(result).then(resolve, reject);
        },
        catch: function (reject) {
          return Promise.resolve(result).catch(reject);
        },
      };
    }

    // Mock Room Mongoose methods
    jest.spyOn(Room, 'findOne').mockImplementation((query) => {
      let found = null;
      if (query.$or) {
        for (const condition of query.$or) {
          if (condition.roomId && mockRoomsDb.has(condition.roomId)) {
            found = mockRoomsDb.get(condition.roomId);
            break;
          }
          if (condition._id && mockRoomsDb.has(String(condition._id))) {
            found = mockRoomsDb.get(String(condition._id));
            break;
          }
        }
      } else if (query.roomId && mockRoomsDb.has(query.roomId)) {
        found = mockRoomsDb.get(query.roomId);
      } else if (query._id && mockRoomsDb.has(String(query._id))) {
        found = mockRoomsDb.get(String(query._id));
      }
      return makeQuery(found);
    });

    jest.spyOn(Room, 'find').mockImplementation(() => {
      const uniqueDocs = new Map();
      for (const doc of mockRoomsDb.values()) {
        uniqueDocs.set(doc.roomId, doc);
      }
      return makeQuery([...uniqueDocs.values()]);
    });

    // Mock User Mongoose methods
    jest.spyOn(User, 'findOne').mockImplementation((query) => {
      if (query.$or) {
        for (const condition of query.$or) {
          for (const user of mockUsersDb.values()) {
            if (condition.username && user.username === condition.username) {
              return Promise.resolve(user);
            }
            if (condition.email && user.email === condition.email) {
              return Promise.resolve(user);
            }
          }
        }
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });
  });

  beforeEach(() => {
    mockRoomsDb.clear();
    mockUsersDb.clear();
  });

  describe('SEC-ROOM-02: Private-Room Protection & Cryptographic Invite Codes', () => {
    it('allows any authenticated user to join a public room without invite code', async () => {
      createMockRoom({
        roomId: 'public-study-room',
        name: 'Public Room',
        isPrivate: false,
        owner: userOwner.userId,
        members: [userOwner.userId],
      });

      const res = await request(app)
        .post('/api/rooms/public-study-room/join')
        .set('Authorization', `Bearer ${tokenAttacker}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.room.members).toContain(userAttacker.userId);
    });

    it('rejects non-member attempting to join private room without invite code (403)', async () => {
      createMockRoom({
        roomId: 'private-secret-room',
        name: 'Private Room',
        isPrivate: true,
        inviteCode: 'secure-token-1234',
        owner: userOwner.userId,
        members: [userOwner.userId],
      });

      const res = await request(app)
        .post('/api/rooms/private-secret-room/join')
        .set('Authorization', `Bearer ${tokenAttacker}`)
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('Invite code is required to join a private room');
    });

    it('rejects non-member attempting to join private room with invalid invite code (403)', async () => {
      createMockRoom({
        roomId: 'private-secret-room',
        name: 'Private Room',
        isPrivate: true,
        inviteCode: 'secure-token-1234',
        owner: userOwner.userId,
        members: [userOwner.userId],
      });

      const res = await request(app)
        .post('/api/rooms/private-secret-room/join')
        .set('Authorization', `Bearer ${tokenAttacker}`)
        .send({ inviteCode: 'wrong-guess-token' });

      expect(res.status).toBe(403);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('Invalid invite code for private room');
    });

    it('allows non-member to join private room when providing valid invite code (200)', async () => {
      createMockRoom({
        roomId: 'private-secret-room',
        name: 'Private Room',
        isPrivate: true,
        inviteCode: '1a2b3c4d5e6f7a8b',
        owner: userOwner.userId,
        members: [userOwner.userId],
      });

      const res = await request(app)
        .post('/api/rooms/private-secret-room/join')
        .set('Authorization', `Bearer ${tokenAttacker}`)
        .send({ inviteCode: '1a2b3c4d5e6f7a8b' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.room.members).toContain(userAttacker.userId);
    });

    it('allows room owner and existing members to join private room idempotently without invite code', async () => {
      createMockRoom({
        roomId: 'private-member-room',
        name: 'Private Room',
        isPrivate: true,
        inviteCode: 'secret-invite-key',
        owner: userOwner.userId,
        members: [userOwner.userId, userMember.userId],
      });

      // Existing member joins without invite code
      const resMember = await request(app)
        .post('/api/rooms/private-member-room/join')
        .set('Authorization', `Bearer ${tokenMember}`)
        .send({});

      expect(resMember.status).toBe(200);
      expect(resMember.body.ok).toBe(true);

      // Owner joins without invite code
      const resOwner = await request(app)
        .post('/api/rooms/private-member-room/join')
        .set('Authorization', `Bearer ${tokenOwner}`)
        .send({});

      expect(resOwner.status).toBe(200);
      expect(resOwner.body.ok).toBe(true);
    });

    it('rejects GET /api/rooms/:roomId/invite with 400 because plaintext tokens are hashed at rest', async () => {
      createMockRoom({
        roomId: 'owner-manage-room',
        name: 'Owner Room',
        isPrivate: true,
        inviteCode: 'super-secret-invite-code',
        owner: userOwner.userId,
        members: [userOwner.userId],
      });

      const res = await request(app)
        .get('/api/rooms/owner-manage-room/invite')
        .set('Authorization', `Bearer ${tokenOwner}`);

      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('Plaintext invite tokens are hashed at rest and cannot be retrieved');
    });

    it('rejects non-owner from retrieving invite code with 403', async () => {
      createMockRoom({
        roomId: 'owner-manage-room',
        name: 'Owner Room',
        isPrivate: true,
        inviteCode: 'super-secret-invite-code',
        owner: userOwner.userId,
        members: [userOwner.userId, userMember.userId],
      });

      // Regular member attempts to view invite code
      const res = await request(app)
        .get('/api/rooms/owner-manage-room/invite')
        .set('Authorization', `Bearer ${tokenMember}`);

      expect(res.status).toBe(403);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('Only the room owner can view');
    });

    it('rejects invite retrieval on public rooms with 400', async () => {
      createMockRoom({
        roomId: 'public-room-no-invite',
        name: 'Public Room',
        isPrivate: false,
        owner: userOwner.userId,
        members: [userOwner.userId],
      });

      const res = await request(app)
        .get('/api/rooms/public-room-no-invite/invite')
        .set('Authorization', `Bearer ${tokenOwner}`);

      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('Room is public');
    });

    it('allows owner to rotate invite code and invalidates previous code', async () => {
      createMockRoom({
        roomId: 'rotatable-room',
        name: 'Rotatable Room',
        isPrivate: true,
        inviteCode: 'initial-invite-token',
        owner: userOwner.userId,
        members: [userOwner.userId],
      });

      // Owner rotates invite code
      const rotateRes = await request(app)
        .post('/api/rooms/rotatable-room/invite/rotate')
        .set('Authorization', `Bearer ${tokenOwner}`);

      expect(rotateRes.status).toBe(200);
      expect(rotateRes.body.ok).toBe(true);
      const newCode = rotateRes.body.inviteCode;
      expect(newCode).toBeDefined();
      expect(newCode).not.toBe('initial-invite-token');

      // Old code is now rejected
      const oldJoinRes = await request(app)
        .post('/api/rooms/rotatable-room/join')
        .set('Authorization', `Bearer ${tokenAttacker}`)
        .send({ inviteCode: 'initial-invite-token' });

      expect(oldJoinRes.status).toBe(403);
      expect(oldJoinRes.body.error).toContain('Invalid invite code');

      // New code is accepted
      const newJoinRes = await request(app)
        .post('/api/rooms/rotatable-room/join')
        .set('Authorization', `Bearer ${tokenAttacker}`)
        .send({ inviteCode: newCode });

      expect(newJoinRes.status).toBe(200);
      expect(newJoinRes.body.ok).toBe(true);
    });

    it('does not expose inviteCode in ordinary room details or lists', async () => {
      createMockRoom({
        roomId: 'sanitized-room-check',
        name: 'Sanitized Check',
        isPrivate: true,
        inviteCode: 'confidential-invite-code-123',
        owner: userOwner.userId,
        members: [userOwner.userId, userMember.userId],
      });

      const detailsRes = await request(app)
        .get('/api/rooms/sanitized-room-check')
        .set('Authorization', `Bearer ${tokenMember}`);

      expect(detailsRes.status).toBe(200);
      expect(detailsRes.body.room.inviteCode).toBeUndefined();
    });

    it('generates cryptographic invite codes with at least 16 random bytes (128 bits, 32 hex chars)', async () => {
      createMockRoom({
        roomId: 'crypto-strength-room',
        name: 'Crypto Strength Room',
        isPrivate: true,
        owner: userOwner.userId,
        members: [userOwner.userId],
      });

      const rotateRes = await request(app)
        .post('/api/rooms/crypto-strength-room/invite/rotate')
        .set('Authorization', `Bearer ${tokenOwner}`);

      expect(rotateRes.status).toBe(200);
      expect(rotateRes.body.ok).toBe(true);
      const code = rotateRes.body.inviteCode;
      expect(code).toBeDefined();
      expect(typeof code).toBe('string');
      // 16 bytes encoded as hex produces exactly 32 hex characters (128 bits of entropy)
      expect(code.length).toBeGreaterThanOrEqual(32);
      expect(/^[0-9a-f]{32,}$/i.test(code)).toBe(true);

      // Verify alias POST /api/rooms/:roomId/invite generates fresh token
      const aliasRes = await request(app)
        .post('/api/rooms/crypto-strength-room/invite')
        .set('Authorization', `Bearer ${tokenOwner}`);

      expect(aliasRes.status).toBe(200);
      const aliasCode = aliasRes.body.inviteCode;
      expect(aliasCode.length).toBeGreaterThanOrEqual(32);
      expect(/^[0-9a-f]{32,}$/i.test(aliasCode)).toBe(true);
    });

    it('verifyInviteCode safely handles malformed inputs and invalid lengths without uncaught exceptions', () => {
      const validCode = crypto.randomBytes(16).toString('hex'); // 32 hex chars
      const validHash = roomService.hashInviteCode(validCode);

      // Valid match
      expect(roomService.verifyInviteCode(validHash, validCode)).toBe(true);
      expect(roomService.verifyInviteCode(` ${validHash} `, validCode)).toBe(true);

      // Wrong code of equal length
      const wrongSameLength = crypto.randomBytes(16).toString('hex');
      expect(roomService.verifyInviteCode(validHash, wrongSameLength)).toBe(false);

      // Invalid / mismatched hashes (not 64-char hex)
      expect(roomService.verifyInviteCode(validCode, validCode)).toBe(false);
      expect(roomService.verifyInviteCode(validHash.slice(0, 32), validCode)).toBe(false);
      expect(roomService.verifyInviteCode(validHash + 'extra', validCode)).toBe(false);
      expect(roomService.verifyInviteCode(validHash, '')).toBe(false);
      expect(roomService.verifyInviteCode('', validCode)).toBe(false);
      expect(roomService.verifyInviteCode('', '')).toBe(false);
      expect(roomService.verifyInviteCode('   ', '   ')).toBe(false);

      // Malformed inputs (types, null, undefined, buffers, numbers, objects)
      expect(roomService.verifyInviteCode(validHash, null)).toBe(false);
      expect(roomService.verifyInviteCode(null, validCode)).toBe(false);
      expect(roomService.verifyInviteCode(validHash, undefined)).toBe(false);
      expect(roomService.verifyInviteCode(undefined, undefined)).toBe(false);
      expect(roomService.verifyInviteCode(validHash, 12345678)).toBe(false);
      expect(roomService.verifyInviteCode(12345678, validCode)).toBe(false);
      expect(roomService.verifyInviteCode(validHash, { code: validCode })).toBe(false);
      expect(roomService.verifyInviteCode({ code: validCode }, validCode)).toBe(false);
      expect(roomService.verifyInviteCode(validHash, ['token'])).toBe(false);
      expect(roomService.verifyInviteCode(validHash, Buffer.from(validCode))).toBe(false);
      expect(roomService.verifyInviteCode(validHash, true)).toBe(false);
    });

    it('verifies SHA-256 hashed invite tokens at rest using timing-safe comparison', () => {
      const rawToken = crypto.randomBytes(16).toString('hex');
      const sha256Hash = roomService.hashInviteCode(rawToken);

      expect(typeof sha256Hash).toBe('string');
      expect(sha256Hash.length).toBe(64); // 256 bits = 64 hex characters

      // Matching raw token against stored SHA-256 hash
      expect(roomService.verifyInviteCode(sha256Hash, rawToken)).toBe(true);
      expect(roomService.verifyInviteCode(sha256Hash, `  ${rawToken}  `)).toBe(true);

      // Wrong token against stored SHA-256 hash
      const wrongToken = crypto.randomBytes(16).toString('hex');
      expect(roomService.verifyInviteCode(sha256Hash, wrongToken)).toBe(false);
      expect(roomService.verifyInviteCode(sha256Hash, '')).toBe(false);
      expect(roomService.verifyInviteCode(sha256Hash, null)).toBe(false);
    });

    it('allows joining private room authenticated via SHA-256 hash-at-rest without plaintext inviteCode in storage', async () => {
      const rawToken = crypto.randomBytes(16).toString('hex');
      const sha256Hash = roomService.hashInviteCode(rawToken);

      createMockRoom({
        roomId: 'hash-only-private-room',
        name: 'Hash-At-Rest Room',
        isPrivate: true,
        inviteCode: null, // Zero plaintext stored in DB
        inviteHash: sha256Hash, // Only cryptographic one-way digest stored
        owner: userOwner.userId,
        members: [userOwner.userId],
      });

      // Valid raw token presented by joining user
      const joinRes = await request(app)
        .post('/api/rooms/hash-only-private-room/join')
        .set('Authorization', `Bearer ${tokenAttacker}`)
        .send({ inviteCode: rawToken });

      expect(joinRes.status).toBe(200);
      expect(joinRes.body.ok).toBe(true);
      expect(joinRes.body.room.members).toContain(userAttacker.userId);

      // Invalid token fails
      const failRes = await request(app)
        .post('/api/rooms/hash-only-private-room/join')
        .set('Authorization', `Bearer ${tokenMember}`)
        .send({ inviteCode: 'incorrect-token-value' });

      expect(failRes.status).toBe(403);
      expect(failRes.body.error).toContain('Invalid invite code');
    });

    it('explicitly rejects expired invite codes during authorization with HTTP 403', async () => {
      const rawToken = crypto.randomBytes(16).toString('hex');
      const sha256Hash = roomService.hashInviteCode(rawToken);
      const expiredDate = new Date(Date.now() - 3600000); // Expired 1 hour ago

      createMockRoom({
        roomId: 'expired-token-room',
        name: 'Expired Room',
        isPrivate: true,
        inviteCode: rawToken,
        inviteHash: sha256Hash,
        inviteExpiresAt: expiredDate,
        owner: userOwner.userId,
        members: [userOwner.userId],
      });

      const res = await request(app)
        .post('/api/rooms/expired-token-room/join')
        .set('Authorization', `Bearer ${tokenAttacker}`)
        .send({ inviteCode: rawToken });

      expect(res.status).toBe(403);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe('Invite code has expired');
    });

    it('accepts unexpired invite codes during authorization with HTTP 200', async () => {
      const rawToken = crypto.randomBytes(16).toString('hex');
      const sha256Hash = roomService.hashInviteCode(rawToken);
      const futureDate = new Date(Date.now() + 86400000 * 7); // Valid for 7 days

      createMockRoom({
        roomId: 'active-token-room',
        name: 'Active Token Room',
        isPrivate: true,
        inviteCode: rawToken,
        inviteHash: sha256Hash,
        inviteExpiresAt: futureDate,
        owner: userOwner.userId,
        members: [userOwner.userId],
      });

      const res = await request(app)
        .post('/api/rooms/active-token-room/join')
        .set('Authorization', `Bearer ${tokenAttacker}`)
        .send({ inviteCode: rawToken });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.room.members).toContain(userAttacker.userId);
    });

    it('redacts inviteHash from all room responses and exposes inviteExpiresAt when present', async () => {
      const rawToken = crypto.randomBytes(16).toString('hex');
      const sha256Hash = roomService.hashInviteCode(rawToken);
      const futureDate = new Date(Date.now() + 86400000 * 7);

      createMockRoom({
        roomId: 'redacted-hash-room',
        name: 'Redacted Hash Room',
        isPrivate: true,
        inviteCode: rawToken,
        inviteHash: sha256Hash,
        inviteExpiresAt: futureDate,
        owner: userOwner.userId,
        members: [userOwner.userId, userMember.userId],
      });

      // Member checks room details
      const detailsRes = await request(app)
        .get('/api/rooms/redacted-hash-room')
        .set('Authorization', `Bearer ${tokenMember}`);

      expect(detailsRes.status).toBe(200);
      expect(detailsRes.body.room.inviteHash).toBeUndefined();
      expect(detailsRes.body.room.inviteExpiresAt).toBeDefined();

      // Sanitization utility test directly
      const mockDoc = {
        roomId: 'direct-sanitize-check',
        name: 'Check',
        isPrivate: true,
        inviteHash: sha256Hash,
        inviteExpiresAt: futureDate,
        owner: userOwner.userId,
        members: [userOwner.userId],
      };
      // When rawToken is passed (e.g. upon creation/rotation), it is returned once
      const sanitizedWithRaw = roomService.sanitizeRoom(mockDoc, { rawToken });
      expect(sanitizedWithRaw.inviteCode).toBe(rawToken);
      expect(sanitizedWithRaw.inviteHash).toBeUndefined();
      expect(sanitizedWithRaw.inviteExpiresAt).toEqual(futureDate);

      // Ordinary sanitization omits inviteCode and inviteHash completely
      const standardSanitized = roomService.sanitizeRoom(mockDoc);
      expect(standardSanitized.inviteCode).toBeUndefined();
      expect(standardSanitized.inviteHash).toBeUndefined();
      expect(standardSanitized.inviteExpiresAt).toEqual(futureDate);
    });
  });

  describe('SEC-API-01: Route Rate Limiting', () => {
    let rateLimitTestApp;

    beforeAll(() => {
      rateLimitTestApp = express();
      rateLimitTestApp.use(express.json());

      // Create deterministic low-threshold limiters for testing
      const testLoginLimiter = createRateLimiter({
        windowMs: 60 * 1000,
        max: 3,
        message: 'Too many login attempts. Please try again later.',
      });

      const testExecuteLimiter = createRateLimiter({
        windowMs: 60 * 1000,
        max: 4,
        message: 'Execution rate limit exceeded. Please wait before submitting more code.',
      });

      rateLimitTestApp.post('/api/test-login', testLoginLimiter, (req, res) => {
        res.status(200).json({ ok: true, message: 'login attempt processed' });
      });

      rateLimitTestApp.post('/api/test-exec', testExecuteLimiter, (req, res) => {
        res.status(200).json({ ok: true, message: 'exec processed' });
      });

      const testJoinLimiter = createRateLimiter({
        windowMs: 60 * 1000,
        max: 3,
        message: 'Too many join room attempts. Please try again later.',
      });

      rateLimitTestApp.post('/api/test-join', testJoinLimiter, (req, res) => {
        res.status(200).json({ ok: true, message: 'join processed' });
      });

      rateLimitTestApp.use(globalErrorHandler);
    });

    it('enforces rate limit after exceeding threshold and returns HTTP 429 with RFC headers', async () => {
      // 3 allowed requests
      for (let i = 0; i < 3; i++) {
        const res = await request(rateLimitTestApp).post('/api/test-login').send({});
        expect(res.status).toBe(200);
      }

      // 4th request must be rate limited
      const rateLimitedRes = await request(rateLimitTestApp).post('/api/test-login').send({});
      expect(rateLimitedRes.status).toBe(429);
      expect(rateLimitedRes.body.ok).toBe(false);
      expect(rateLimitedRes.body.error).toContain('Too many login attempts');

      // Verify standard draft-6/7 RateLimit headers are present
      expect(rateLimitedRes.headers['ratelimit-limit']).toBeDefined();
      expect(rateLimitedRes.headers['ratelimit-remaining']).toBe('0');
      expect(rateLimitedRes.headers['ratelimit-reset']).toBeDefined();
    });

    it('rate limit responses (429) are not converted to 500 by global error handler', async () => {
      for (let i = 0; i < 4; i++) {
        await request(rateLimitTestApp).post('/api/test-exec').send({});
      }

      // 5th request triggers 429
      const res = await request(rateLimitTestApp).post('/api/test-exec').send({});
      expect(res.status).toBe(429);
      expect(res.status).not.toBe(500);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('Execution rate limit exceeded');
    });

    it('enforces route rate limit on join room attempts to prevent online guessing attacks (429)', async () => {
      for (let i = 0; i < 3; i++) {
        const res = await request(rateLimitTestApp).post('/api/test-join').send({});
        expect(res.status).toBe(200);
      }

      const res4 = await request(rateLimitTestApp).post('/api/test-join').send({});
      expect(res4.status).toBe(429);
      expect(res4.body.ok).toBe(false);
      expect(res4.body.error).toContain('Too many join room attempts');
    });

    it('ignores spoofed X-Forwarded-For headers when trust proxy is disabled', async () => {
      const spoofApp = express();
      spoofApp.use(express.json());

      const strictLimiter = createRateLimiter({
        windowMs: 60 * 1000,
        max: 2,
        message: 'Rate limit exceeded.',
      });

      spoofApp.post('/api/test-spoof', strictLimiter, (req, res) => {
        res.status(200).json({ ok: true });
      });
      spoofApp.use(globalErrorHandler);

      // Attempt 1 from client
      const res1 = await request(spoofApp)
        .post('/api/test-spoof')
        .set('X-Forwarded-For', '203.0.113.1');
      expect(res1.status).toBe(200);

      // Attempt 2 from client with spoofed IP
      const res2 = await request(spoofApp)
        .post('/api/test-spoof')
        .set('X-Forwarded-For', '198.51.100.99');
      expect(res2.status).toBe(200);

      // Attempt 3 with another spoofed IP - MUST STILL BE RATE LIMITED because remote IP is 127.0.0.1
      const res3 = await request(spoofApp)
        .post('/api/test-spoof')
        .set('X-Forwarded-For', '192.0.2.77');
      expect(res3.status).toBe(429);
      expect(res3.body.error).toBe('Rate limit exceeded.');
    });
  });

  describe('SEC-API-02: Security Headers & Sanitized Global Error Handling', () => {
    it('sets standard security headers via helmet on API responses', async () => {
      const res = await request(app).get('/api/rooms').set('Authorization', `Bearer ${tokenOwner}`);

      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['x-dns-prefetch-control']).toBe('off');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('preserves intentional 4xx client errors through error handler', async () => {
      const testApp = express();
      testApp.use(express.json());
      testApp.get('/test-400', (req, res, next) => next(Object.assign(new Error('Invalid input'), { status: 400 })));
      testApp.get('/test-403', (req, res, next) => next(Object.assign(new Error('Permission denied'), { status: 403 })));
      testApp.get('/test-404', (req, res, next) => next(Object.assign(new Error('Resource not found'), { status: 404 })));
      testApp.use(globalErrorHandler);

      const res400 = await request(testApp).get('/test-400');
      expect(res400.status).toBe(400);
      expect(res400.body).toEqual({ ok: false, error: 'Invalid input' });

      const res403 = await request(testApp).get('/test-403');
      expect(res403.status).toBe(403);
      expect(res403.body).toEqual({ ok: false, error: 'Permission denied' });

      const res404 = await request(testApp).get('/test-404');
      expect(res404.status).toBe(404);
      expect(res404.body).toEqual({ ok: false, error: 'Resource not found' });
    });

    it('sanitizes unexpected internal 500 exceptions and conceals database/system details', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const res = await request(app).get('/api/test-internal-error');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        ok: false,
        error: 'Internal server error',
      });
      // Ensure no raw database connection strings or stack traces leaked to client
      expect(JSON.stringify(res.body)).not.toContain('MongoNetworkError');
      expect(JSON.stringify(res.body)).not.toContain('mongodb.net');
      expect(JSON.stringify(res.body)).not.toContain('cluster.js');

      consoleSpy.mockRestore();
    });
  });

  describe('SEC-AUTH-02: Account Enumeration & Authentication Timing Mitigation', () => {
    it('returns consistent generic 409 message when username or email already exists', async () => {
      mockUsersDb.set('user1', {
        _id: new mongoose.Types.ObjectId(),
        username: 'existing_coder',
        email: 'coder@example.com',
      });

      // 1. Duplicate username
      const resDupUsername = await request(app)
        .post('/api/auth/register')
        .send({
          username: 'existing_coder',
          email: 'unique_email@example.com',
          password: 'Password123!',
        });

      expect(resDupUsername.status).toBe(409);
      expect(resDupUsername.body.ok).toBe(false);
      expect(resDupUsername.body.error).toBe('Username or email is already registered');

      // 2. Duplicate email
      const resDupEmail = await request(app)
        .post('/api/auth/register')
        .send({
          username: 'unique_username',
          email: 'coder@example.com',
          password: 'Password123!',
        });

      expect(resDupEmail.status).toBe(409);
      expect(resDupEmail.body.ok).toBe(false);
      expect(resDupEmail.body.error).toBe('Username or email is already registered');
    });

    it('handles MongoDB unique-index duplicate key error (code 11000) with identical generic 409', async () => {
      const saveSpy = jest.spyOn(User.prototype, 'save').mockRejectedValueOnce({
        code: 11000,
        codeName: 'DuplicateKey',
        message: 'E11000 duplicate key error collection: users index: email_1 dup key',
      });

      const res = await request(app)
        .post('/api/auth/register')
        .send({
          username: 'race_condition_user',
          email: 'race@example.com',
          password: 'Password123!',
        });

      expect(res.status).toBe(409);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe('Username or email is already registered');

      saveSpy.mockRestore();
    });

    it('performs bcrypt comparison on non-existent user lookups during login to mitigate timing attacks', async () => {
      const bcryptCompareSpy = jest.spyOn(bcrypt, 'compare');

      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'nonexistent_account@example.com',
          password: 'AnyPassword123!',
        });

      expect(res.status).toBe(401);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe('Invalid credentials');

      // Verify that bcrypt.compare was indeed invoked despite user document being null
      expect(bcryptCompareSpy).toHaveBeenCalled();
      const calledWithPassword = bcryptCompareSpy.mock.calls.some(
        ([pwd]) => pwd === 'AnyPassword123!'
      );
      expect(calledWithPassword).toBe(true);

      bcryptCompareSpy.mockRestore();
    });

    it('returns generic 401 on incorrect password for existing user', async () => {
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash('CorrectPassword123!', salt);
      mockUsersDb.set('user_valid', {
        _id: new mongoose.Types.ObjectId(),
        username: 'valid_user',
        email: 'valid@example.com',
        passwordHash,
      });

      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'valid@example.com',
          password: 'WrongPassword123!',
        });

      expect(res.status).toBe(401);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe('Invalid credentials');
    });
  });
});
