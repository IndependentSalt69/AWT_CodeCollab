/**
 * Backend Room Management & Database Persistence API Tests (M0.8)
 *
 * Validates:
 * - Authenticated room creation (POST /api/rooms)
 * - Creator automatically assigned as owner and persistent member
 * - Validation: empty name, missing name, length limits
 * - List rooms (GET /api/rooms): returns user's rooms only
 * - Room details (GET /api/rooms/:roomId): returns details only to members; rejects non-members (403)
 * - Room join (POST /api/rooms/:roomId/join & POST /api/rooms/join): adds member idempotently
 * - Unknown roomId returns 404
 * - Unauthenticated requests return 401
 * - Controlled database error handling (500) without crashing server
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const Room = require('../../database/models/Room');
const roomsRouter = require('../../backend/src/routes/rooms');
const { generateToken } = require('../../backend/src/middleware/auth');

describe('Backend Room Management API & Database Persistence (M0.8)', () => {
  let app;
  const mockRoomsDb = new Map();

  const userAlice = {
    userId: '67056a1b2c3d4e5f6a7b8c01',
    id: '67056a1b2c3d4e5f6a7b8c01',
    username: 'alice',
    email: 'alice@example.com',
  };

  const userBob = {
    userId: '67056a1b2c3d4e5f6a7b8c02',
    id: '67056a1b2c3d4e5f6a7b8c02',
    username: 'bob',
    email: 'bob@example.com',
  };

  const userCharlie = {
    userId: '67056a1b2c3d4e5f6a7b8c03',
    id: '67056a1b2c3d4e5f6a7b8c03',
    username: 'charlie',
    email: 'charlie@example.com',
  };

  const tokenAlice = generateToken(userAlice);
  const tokenBob = generateToken(userBob);
  const tokenCharlie = generateToken(userCharlie);

  // Helper to create mock Mongoose room document
  function createMockRoomDoc(data) {
    const doc = {
      _id: data._id || new mongoose.Types.ObjectId(),
      roomId: data.roomId,
      name: data.name,
      language: data.language || 'python',
      isPrivate: Boolean(data.isPrivate),
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
    app.use(express.json());
    app.use('/api/rooms', roomsRouter);

    // Mock Room constructor
    jest.spyOn(Room.prototype, 'save').mockImplementation(function () {
      if (!this._id) {
        this._id = new mongoose.Types.ObjectId();
      }
      this.createdAt = new Date();
      this.updatedAt = new Date();
      this.populate = jest.fn().mockResolvedValue(this);
      this.toObject = function () {
        return {
          id: String(this._id),
          _id: String(this._id),
          roomId: this.roomId,
          name: this.name,
          language: this.language,
          isPrivate: this.isPrivate,
          currentCode: this.currentCode,
          owner: this.owner,
          members: this.members,
          createdAt: this.createdAt,
          updatedAt: this.updatedAt,
        };
      };
      mockRoomsDb.set(this.roomId, this);
      mockRoomsDb.set(String(this._id), this);
      return Promise.resolve(this);
    });

    // Mock Room.findOne
    jest.spyOn(Room, 'findOne').mockImplementation((query) => {
      let target = null;
      if (query.roomId) {
        target = mockRoomsDb.get(query.roomId) || null;
      } else if (query._id) {
        target = mockRoomsDb.get(String(query._id)) || null;
      } else if (query.$or) {
        for (const cond of query.$or) {
          if (cond.roomId && mockRoomsDb.has(cond.roomId)) {
            target = mockRoomsDb.get(cond.roomId);
            break;
          }
          if (cond._id && mockRoomsDb.has(String(cond._id))) {
            target = mockRoomsDb.get(String(cond._id));
            break;
          }
        }
      }
      return {
        populate: () => ({
          populate: () => Promise.resolve(target),
          then: (resolve) => resolve(target),
        }),
        then: (resolve) => resolve(target),
      };
    });

    // Mock Room.find
    jest.spyOn(Room, 'find').mockImplementation((query) => {
      const allRooms = Array.from(new Set(mockRoomsDb.values()));
      let filtered = allRooms;

      if (query && query.$or) {
        filtered = allRooms.filter((room) => {
          return query.$or.some((cond) => {
            if (cond.owner) {
              const ownerId = String(room.owner?._id || room.owner);
              if (ownerId === String(cond.owner)) return true;
            }
            if (cond.members) {
              const inMembers = Array.isArray(room.members) && room.members.some(
                (m) => String(m?._id || m) === String(cond.members)
              );
              if (inMembers) return true;
            }
            return false;
          });
        });
      }

      return {
        sort: () => ({
          populate: () => ({
            populate: () => Promise.resolve(filtered),
            then: (resolve) => resolve(filtered),
          }),
          then: (resolve) => resolve(filtered),
        }),
        populate: () => ({
          populate: () => Promise.resolve(filtered),
          then: (resolve) => resolve(filtered),
        }),
        then: (resolve) => resolve(filtered),
      };
    });
  });

  beforeEach(() => {
    mockRoomsDb.clear();
  });

  describe('1. Room Creation (POST /api/rooms)', () => {
    it('should create a room, assign owner, add creator as member, and return 201', async () => {
      const res = await request(app)
        .post('/api/rooms')
        .set('Authorization', `Bearer ${tokenAlice}`)
        .send({
          name: 'Algorithms Practice',
          language: 'python',
        });

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.room).toBeDefined();
      expect(res.body.room.name).toBe('Algorithms Practice');
      expect(res.body.room.roomId).toMatch(/^algorithms-practice-[a-f0-9]{6}$/);
      expect(res.body.room.language).toBe('python');
      const ownerId = res.body.room.owner?.id || res.body.room.owner?._id || res.body.room.owner;
      expect(ownerId).toBe(userAlice.userId);
      const memberIds = res.body.room.members.map((m) => m?.id || m?._id || m);
      expect(memberIds).toContain(userAlice.userId);
    });

    it('should reject unauthenticated room creation with 401', async () => {
      const res = await request(app)
        .post('/api/rooms')
        .send({ name: 'Algorithms Practice' });

      expect(res.status).toBe(401);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('Authentication required');
    });

    it('should reject room creation with missing or empty name with 400', async () => {
      const res = await request(app)
        .post('/api/rooms')
        .set('Authorization', `Bearer ${tokenAlice}`)
        .send({ name: '   ' });

      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('Room name is required');
    });

    it('should reject room creation with name over 100 characters with 400', async () => {
      const longName = 'a'.repeat(101);
      const res = await request(app)
        .post('/api/rooms')
        .set('Authorization', `Bearer ${tokenAlice}`)
        .send({ name: longName });

      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('cannot exceed 100 characters');
    });
  });

  describe('2. Room Listing (GET /api/rooms)', () => {
    it('should return only rooms where authenticated user is an owner or member', async () => {
      // Room 1: Alice owner & member
      createMockRoomDoc({
        roomId: 'room-alice-1',
        name: 'Alice Room',
        owner: userAlice.userId,
        members: [userAlice.userId],
      });

      // Room 2: Bob owner, Alice member
      createMockRoomDoc({
        roomId: 'room-shared-2',
        name: 'Shared Room',
        owner: userBob.userId,
        members: [userBob.userId, userAlice.userId],
      });

      // Room 3: Bob owner, Charlie member (Alice is NOT member)
      createMockRoomDoc({
        roomId: 'room-bob-3',
        name: 'Bob Secret Room',
        owner: userBob.userId,
        members: [userBob.userId, userCharlie.userId],
      });

      const res = await request(app)
        .get('/api/rooms')
        .set('Authorization', `Bearer ${tokenAlice}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.rooms)).toBe(true);
      expect(res.body.rooms.length).toBe(2);

      const roomIds = res.body.rooms.map((r) => r.roomId);
      expect(roomIds).toContain('room-alice-1');
      expect(roomIds).toContain('room-shared-2');
      expect(roomIds).not.toContain('room-bob-3');
    });

    it('should reject unauthenticated room listing with 401', async () => {
      const res = await request(app).get('/api/rooms');
      expect(res.status).toBe(401);
      expect(res.body.ok).toBe(false);
    });
  });

  describe('3. Room Details (GET /api/rooms/:roomId)', () => {
    it('should allow member to view room details with 200', async () => {
      createMockRoomDoc({
        roomId: 'room-test-101',
        name: 'Competitive Programming',
        owner: userAlice.userId,
        members: [userAlice.userId, userBob.userId],
      });

      const res = await request(app)
        .get('/api/rooms/room-test-101')
        .set('Authorization', `Bearer ${tokenBob}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.room.name).toBe('Competitive Programming');
      expect(res.body.room.roomId).toBe('room-test-101');
    });

    it('should reject non-member with 403 Forbidden', async () => {
      createMockRoomDoc({
        roomId: 'room-private-202',
        name: 'Private Room',
        owner: userAlice.userId,
        members: [userAlice.userId],
      });

      const res = await request(app)
        .get('/api/rooms/room-private-202')
        .set('Authorization', `Bearer ${tokenCharlie}`);

      expect(res.status).toBe(403);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('Access denied');
    });

    it('should return 404 Not Found for non-existent room', async () => {
      const res = await request(app)
        .get('/api/rooms/non-existent-room-999')
        .set('Authorization', `Bearer ${tokenAlice}`);

      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe('Room not found');
    });

    it('should reject unauthenticated room details request with 401', async () => {
      const res = await request(app).get('/api/rooms/room-test-101');
      expect(res.status).toBe(401);
    });
  });

  describe('4. Room Join (POST /api/rooms/:roomId/join & POST /api/rooms/join)', () => {
    it('should add user to room members and return updated room (POST /:roomId/join)', async () => {
      const room = createMockRoomDoc({
        roomId: 'room-join-1',
        name: 'Python Study Group',
        owner: userAlice.userId,
        members: [userAlice.userId],
      });

      const res = await request(app)
        .post('/api/rooms/room-join-1/join')
        .set('Authorization', `Bearer ${tokenBob}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.room.members).toContain(userBob.userId);
    });

    it('should support joining via POST /api/rooms/join with joinCode in body', async () => {
      createMockRoomDoc({
        roomId: 'algo-practice-code1',
        name: 'Algorithms Code',
        owner: userAlice.userId,
        members: [userAlice.userId],
      });

      const res = await request(app)
        .post('/api/rooms/join')
        .set('Authorization', `Bearer ${tokenCharlie}`)
        .send({ joinCode: 'algo-practice-code1' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.room.roomId).toBe('algo-practice-code1');
      expect(res.body.room.members).toContain(userCharlie.userId);
    });

    it('should make joining idempotent and not duplicate membership', async () => {
      createMockRoomDoc({
        roomId: 'room-idempotent',
        name: 'Idempotent Test Room',
        owner: userAlice.userId,
        members: [userAlice.userId, userBob.userId],
      });

      // Bob joins again
      const res = await request(app)
        .post('/api/rooms/room-idempotent/join')
        .set('Authorization', `Bearer ${tokenBob}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const memberIds = res.body.room.members.map((m) => String(m.id || m));
      const bobCount = memberIds.filter((id) => id === userBob.userId).length;
      expect(bobCount).toBe(1);
    });

    it('should return 404 when attempting to join a non-existent room', async () => {
      const res = await request(app)
        .post('/api/rooms/non-existent-room/join')
        .set('Authorization', `Bearer ${tokenBob}`);

      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe('Room not found');
    });

    it('should reject unauthenticated room join request with 401', async () => {
      const res = await request(app).post('/api/rooms/any-room/join');
      expect(res.status).toBe(401);
    });
  });

  describe('5. Database Resilience & Error Handling', () => {
    it('should return controlled 500 response on database failure during room creation', async () => {
      const saveSpy = jest.spyOn(Room.prototype, 'save').mockRejectedValueOnce(
        new Error('MongoDB connection timeout')
      );

      const res = await request(app)
        .post('/api/rooms')
        .set('Authorization', `Bearer ${tokenAlice}`)
        .send({ name: 'Crash Test Room' });

      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('MongoDB connection timeout');

      saveSpy.mockRestore();
    });

    it('should return controlled 500 response on database failure during room listing', async () => {
      const findSpy = jest.spyOn(Room, 'find').mockImplementationOnce(() => {
        throw new Error('Database query failure');
      });

      const res = await request(app)
        .get('/api/rooms')
        .set('Authorization', `Bearer ${tokenAlice}`);

      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('Database query failure');

      findSpy.mockRestore();
    });
  });
});
