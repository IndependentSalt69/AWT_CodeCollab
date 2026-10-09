/**
 * Backend Authentication & User Management Tests (M0.7)
 *
 * Validates:
 * - Registration with validation, unique constraints, and bcrypt password hashing
 * - Safe response payloads (never leaking password or passwordHash)
 * - Duplicate registration conflict (409)
 * - Login with email or username, password verification, generic error on mismatch
 * - Protected /api/auth/me profile retrieval
 * - JWT verification (valid, missing, invalid, expired)
 * - Socket identity binding and fail-closed driver execution protection
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const User = require('../../database/models/User');
const authRouter = require('../../backend/src/routes/auth');
const { generateToken, getJwtSecret } = require('../../backend/src/middleware/auth');
const { verifyDriverPermission } = require('../../backend/src/services/executionService');

describe('Backend Authentication API & Identity Binding (M0.7)', () => {
  let app;
  const mockUsersDb = new Map();

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);

    // Mock Mongoose User methods with an in-memory collection
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

    jest.spyOn(User, 'findById').mockImplementation((id) => {
      const user = mockUsersDb.get(String(id));
      if (!user) {
        return {
          select: () => Promise.resolve(null),
        };
      }
      return {
        select: (projection) => {
          if (projection === '-passwordHash') {
            const { passwordHash, ...safeUser } = user;
            return Promise.resolve(safeUser);
          }
          return Promise.resolve(user);
        },
      };
    });

    jest.spyOn(User.prototype, 'save').mockImplementation(function () {
      const doc = {
        _id: this._id || new mongoose.Types.ObjectId(),
        username: this.username,
        email: this.email,
        passwordHash: this.passwordHash,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockUsersDb.set(String(doc._id), doc);
      Object.assign(this, doc);
      return Promise.resolve(this);
    });
  });

  beforeEach(() => {
    mockUsersDb.clear();
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  describe('1. User Registration (POST /api/auth/register)', () => {
    it('should successfully register a new user, hash password, and return JWT with safe profile', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          username: 'alice_dev',
          email: 'alice@example.com',
          password: 'SecurePassword123!',
        });

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.token).toBeDefined();
      expect(res.body.user).toBeDefined();
      expect(res.body.user.username).toBe('alice_dev');
      expect(res.body.user.email).toBe('alice@example.com');
      expect(res.body.user.id).toBeDefined();

      // Ensure password or hash is NEVER returned
      expect(res.body.user.password).toBeUndefined();
      expect(res.body.user.passwordHash).toBeUndefined();

      // Verify stored password in DB is securely hashed
      const storedUser = mockUsersDb.get(res.body.user.id);
      expect(storedUser).toBeDefined();
      expect(storedUser.passwordHash).not.toBe('SecurePassword123!');
      const matches = await bcrypt.compare('SecurePassword123!', storedUser.passwordHash);
      expect(matches).toBe(true);

      // Verify JWT claims
      const decoded = jwt.verify(res.body.token, getJwtSecret());
      expect(decoded.username).toBe('alice_dev');
      expect(decoded.email).toBe('alice@example.com');
    });

    it('should reject registration with missing username (400)', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          email: 'alice@example.com',
          password: 'Password123!',
        });

      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('Username is required');
    });

    it('should reject registration with username under 3 characters (400)', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          username: 'ab',
          email: 'alice@example.com',
          password: 'Password123!',
        });

      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('between 3 and 30 characters');
    });

    it('should reject registration with invalid email format (400)', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          username: 'valid_user',
          email: 'not-an-email',
          password: 'Password123!',
        });

      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('Invalid email format');
    });

    it('should reject registration with password under 6 characters (400)', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          username: 'valid_user',
          email: 'valid@example.com',
          password: '123',
        });

      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('at least 6 characters');
    });

    it('should reject duplicate username with 409 Conflict', async () => {
      // First registration
      await request(app)
        .post('/api/auth/register')
        .send({
          username: 'duplicate_user',
          email: 'first@example.com',
          password: 'Password123!',
        });

      // Second registration with same username
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          username: 'duplicate_user',
          email: 'second@example.com',
          password: 'Password123!',
        });

      expect(res.status).toBe(409);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('already taken');
    });

    it('should reject duplicate email with 409 Conflict', async () => {
      // First registration
      await request(app)
        .post('/api/auth/register')
        .send({
          username: 'user_one',
          email: 'same@example.com',
          password: 'Password123!',
        });

      // Second registration with same email
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          username: 'user_two',
          email: 'same@example.com',
          password: 'Password123!',
        });

      expect(res.status).toBe(409);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('already exists');
    });
  });

  describe('2. User Login (POST /api/auth/login)', () => {
    beforeEach(async () => {
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash('CorrectPassword123!', salt);
      const testUser = {
        _id: new mongoose.Types.ObjectId(),
        username: 'bob_coder',
        email: 'bob@example.com',
        passwordHash,
        createdAt: new Date(),
      };
      mockUsersDb.set(String(testUser._id), testUser);
    });

    it('should log in successfully with valid email and password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'bob@example.com',
          password: 'CorrectPassword123!',
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.username).toBe('bob_coder');
      expect(res.body.user.email).toBe('bob@example.com');
      expect(res.body.user.passwordHash).toBeUndefined();
    });

    it('should log in successfully with username and password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          username: 'bob_coder',
          password: 'CorrectPassword123!',
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.token).toBeDefined();
    });

    it('should reject login with incorrect password with 401', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'bob@example.com',
          password: 'WrongPassword!',
        });

      expect(res.status).toBe(401);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe('Invalid credentials');
    });

    it('should reject login with non-existent user with generic 401', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'ghost@example.com',
          password: 'SomePassword!',
        });

      expect(res.status).toBe(401);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe('Invalid credentials');
    });

    it('should reject login missing credentials with 400', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });
  });

  describe('3. Current User Profile (GET /api/auth/me)', () => {
    let validToken;
    let userId;

    beforeEach(async () => {
      userId = new mongoose.Types.ObjectId().toString();
      const testUser = {
        _id: userId,
        username: 'carol_lead',
        email: 'carol@example.com',
        passwordHash: 'hashed_secret',
        createdAt: new Date(),
      };
      mockUsersDb.set(userId, testUser);

      validToken = generateToken({
        userId,
        id: userId,
        username: 'carol_lead',
        email: 'carol@example.com',
      });
    });

    it('should return current user profile with valid Bearer token', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.user.username).toBe('carol_lead');
      expect(res.body.user.email).toBe('carol@example.com');
      expect(res.body.user.passwordHash).toBeUndefined();
    });

    it('should reject request without Authorization header with 401', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('No token provided');
    });

    it('should reject request with malformed or invalid token with 401', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer invalid.token.payload');

      expect(res.status).toBe(401);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('Invalid authentication token');
    });

    it('should reject expired token with 401', async () => {
      const expiredToken = jwt.sign(
        { userId, username: 'carol_lead' },
        getJwtSecret(),
        { expiresIn: '-1s' }
      );

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${expiredToken}`);

      expect(res.status).toBe(401);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('expired');
    });
  });

  describe('4. Socket Identity Binding & Fail-Closed Driver Authorization', () => {
    const { setDriver, removeDriver } = require('../../realtime/server/driverState');

    afterEach(() => {
      removeDriver('room-sec-test');
    });

    it('should fail closed (403) when driver socket has missing user metadata', async () => {
      const mockIo = {
        sockets: {
          sockets: new Map([
            [
              'socket-driver-anon',
              {
                id: 'socket-driver-anon',
                data: {}, // No verifiedUser or user metadata
              },
            ],
          ]),
        },
      };

      setDriver('room-sec-test', 'socket-driver-anon');

      const authCheck = await verifyDriverPermission({
        roomId: 'room-sec-test',
        user: { userId: 'user-123', username: 'attacker' },
        socketId: 'socket-driver-anon',
        io: mockIo,
      });

      expect(authCheck.authorized).toBe(false);
      expect(authCheck.status).toBe(403);
      expect(authCheck.error).toContain('not authenticated with a verified user identity');
    });

    it('should fail closed (403) when authenticated HTTP user does not match driver socket user', async () => {
      const mockIo = {
        sockets: {
          sockets: new Map([
            [
              'socket-driver-legit',
              {
                id: 'socket-driver-legit',
                data: {
                  verifiedUser: {
                    userId: 'driver-user-999',
                    username: 'legit_driver',
                  },
                },
              },
            ],
          ]),
        },
      };

      setDriver('room-sec-test', 'socket-driver-legit');

      // Attacker tries to execute using driver's socketId but different authenticated JWT
      const authCheck = await verifyDriverPermission({
        roomId: 'room-sec-test',
        user: { userId: 'attacker-111', username: 'attacker' },
        socketId: 'socket-driver-legit',
        io: mockIo,
      });

      expect(authCheck.authorized).toBe(false);
      expect(authCheck.status).toBe(403);
      expect(authCheck.error).toContain('does not match the active room driver session');
    });

    it('should authorize successfully when authenticated HTTP user matches verified driver socket', async () => {
      const mockIo = {
        sockets: {
          sockets: new Map([
            [
              'socket-driver-valid',
              {
                id: 'socket-driver-valid',
                data: {
                  verifiedUser: {
                    userId: 'driver-user-888',
                    username: 'authorized_driver',
                  },
                },
              },
            ],
          ]),
        },
      };

      setDriver('room-sec-test', 'socket-driver-valid');

      const authCheck = await verifyDriverPermission({
        roomId: 'room-sec-test',
        user: { userId: 'driver-user-888', username: 'authorized_driver' },
        socketId: 'socket-driver-valid',
        io: mockIo,
      });

      expect(authCheck.authorized).toBe(true);
    });
  });
});
