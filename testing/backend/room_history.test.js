/**
 * Room history API tests
 *
 * Validates:
 * - GET /api/rooms/:roomId/messages returns persisted chat history to members only
 * - GET /api/rooms/:roomId/executions returns run history to members only
 * - Cursor pagination (limit/before) validation and ordering
 * - Unexpected server errors are not leaked to clients
 */

const request = require('supertest');
const express = require('express');

const Room = require('../../database/models/Room');
const Message = require('../../database/models/Message');
const ExecutionRun = require('../../database/models/ExecutionRun');
const roomsRouter = require('../../backend/src/routes/rooms');
const { generateToken } = require('../../backend/src/middleware/auth');

const userAlice = { userId: '67056a1b2c3d4e5f6a7b8c01', id: '67056a1b2c3d4e5f6a7b8c01', username: 'alice' };
const userBob = { userId: '67056a1b2c3d4e5f6a7b8c02', id: '67056a1b2c3d4e5f6a7b8c02', username: 'bob' };
const userEve = { userId: '67056a1b2c3d4e5f6a7b8c99', id: '67056a1b2c3d4e5f6a7b8c99', username: 'eve' };

const tokenAlice = generateToken(userAlice);
const tokenBob = generateToken(userBob);
const tokenEve = generateToken(userEve);

const ROOM_OBJECT_ID = '67056a1b2c3d4e5f6a7b8d00';
const room = {
  _id: ROOM_OBJECT_ID,
  roomId: 'pair-room-a1b2c3',
  name: 'Pair Room',
  owner: userAlice.id,
  members: [userAlice.id, userBob.id],
};

// Builds a chainable query mock: find().sort().limit().populate().lean()
function queryChain(rows, captured) {
  const chain = {
    sort: (spec) => { captured.sort = spec; return chain; },
    limit: (n) => { captured.limit = n; return chain; },
    populate: () => chain,
    lean: () => {
      let result = rows.filter((r) => r.roomId === captured.query.roomId);
      if (captured.query._id?.$lt) {
        const cursor = String(captured.query._id.$lt);
        result = result.filter((r) => String(r._id) < cursor);
      }
      result.sort((a, b) => (String(a._id) < String(b._id) ? 1 : -1));
      return Promise.resolve(result.slice(0, captured.limit));
    },
  };
  return chain;
}

function objectId(n) {
  return `67056a1b2c3d4e5f6a7b9${String(n).padStart(3, '0')}`;
}

describe('Room History API', () => {
  let app;
  let messages;
  let runs;
  let captured;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/rooms', roomsRouter);

    jest.spyOn(Room, 'findOne').mockImplementation((query) => {
      const conditions = query.$or || [query];
      const match = conditions.some(
        (c) => c.roomId === room.roomId || String(c._id) === ROOM_OBJECT_ID
      );
      const target = match ? room : null;
      return {
        populate: () => ({ populate: () => Promise.resolve(target) }),
        then: (resolve) => resolve(target),
      };
    });

    jest.spyOn(Message, 'find').mockImplementation((query) => {
      captured = { query };
      return queryChain(messages, captured);
    });

    jest.spyOn(ExecutionRun, 'find').mockImplementation((query) => {
      captured = { query };
      return queryChain(runs, captured);
    });
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    captured = null;
    messages = [1, 2, 3].map((n) => ({
      _id: objectId(n),
      roomId: room.roomId,
      sender: userBob.id,
      senderUsername: 'bob',
      content: `message ${n}`,
      createdAt: new Date(2026, 9, n),
    }));
    messages.push({
      _id: objectId(50),
      roomId: 'other-room',
      sender: userEve.id,
      senderUsername: 'eve',
      content: 'other room secret',
      createdAt: new Date(),
    });
    runs = [
      {
        _id: objectId(10),
        roomId: room.roomId,
        triggeredBy: { _id: userAlice.id, username: 'alice' },
        language: 'python',
        code: 'print("hi")',
        status: 'completed',
        stdout: 'hi\n',
        stderr: '',
        exitCode: 0,
        executionTimeMs: 120,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: objectId(11),
        roomId: room.roomId,
        triggeredBy: { _id: userAlice.id, username: 'alice' },
        language: 'python',
        code: 'while True: pass',
        status: 'timeout',
        stdout: '',
        stderr: 'Execution timed out after 5000ms',
        exitCode: 124,
        executionTimeMs: 5003,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
  });

  describe('GET /api/rooms/:roomId/messages', () => {
    it('returns room messages newest first to a member', async () => {
      const res = await request(app)
        .get(`/api/rooms/${room.roomId}/messages`)
        .set('Authorization', `Bearer ${tokenBob}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.messages.map((m) => m.content)).toEqual(['message 3', 'message 2', 'message 1']);
      expect(res.body.messages[0]).toEqual({
        id: objectId(3),
        roomId: room.roomId,
        content: 'message 3',
        sender: { id: userBob.id, username: 'bob' },
        timestamp: expect.any(String),
      });
      expect(res.body.nextCursor).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain('other room secret');
    });

    it('uses the canonical roomId when requested by database _id', async () => {
      const res = await request(app)
        .get(`/api/rooms/${ROOM_OBJECT_ID}/messages`)
        .set('Authorization', `Bearer ${tokenAlice}`);

      expect(res.status).toBe(200);
      expect(captured.query.roomId).toBe(room.roomId);
      expect(res.body.messages).toHaveLength(3);
    });

    it('paginates with limit and before cursor', async () => {
      const first = await request(app)
        .get(`/api/rooms/${room.roomId}/messages?limit=2`)
        .set('Authorization', `Bearer ${tokenAlice}`);

      expect(first.status).toBe(200);
      expect(first.body.messages.map((m) => m.content)).toEqual(['message 3', 'message 2']);
      expect(first.body.nextCursor).toBe(objectId(2));

      const second = await request(app)
        .get(`/api/rooms/${room.roomId}/messages?limit=2&before=${first.body.nextCursor}`)
        .set('Authorization', `Bearer ${tokenAlice}`);

      expect(second.status).toBe(200);
      expect(second.body.messages.map((m) => m.content)).toEqual(['message 1']);
      expect(second.body.nextCursor).toBeNull();
    });

    it.each([
      ['limit=0'],
      ['limit=101'],
      ['limit=abc'],
      ['before=not-an-id'],
    ])('rejects invalid pagination query %s with 400', async (qs) => {
      const res = await request(app)
        .get(`/api/rooms/${room.roomId}/messages?${qs}`)
        .set('Authorization', `Bearer ${tokenAlice}`);

      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('rejects non-members with 403', async () => {
      const res = await request(app)
        .get(`/api/rooms/${room.roomId}/messages`)
        .set('Authorization', `Bearer ${tokenEve}`);

      expect(res.status).toBe(403);
      expect(res.body.messages).toBeUndefined();
      expect(captured).toBeNull();
    });

    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app).get(`/api/rooms/${room.roomId}/messages`);
      expect(res.status).toBe(401);
    });

    it('returns 404 for unknown rooms', async () => {
      const res = await request(app)
        .get('/api/rooms/missing-room/messages')
        .set('Authorization', `Bearer ${tokenAlice}`);
      expect(res.status).toBe(404);
    });

    it('does not leak internal database errors', async () => {
      Message.find.mockImplementationOnce(() => {
        throw new Error('connection refused at 10.0.0.5:27017');
      });

      const res = await request(app)
        .get(`/api/rooms/${room.roomId}/messages`)
        .set('Authorization', `Bearer ${tokenAlice}`);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Failed to fetch chat history');
    });
  });

  describe('GET /api/rooms/:roomId/executions', () => {
    it('returns run history with status, timing and output to a member', async () => {
      const res = await request(app)
        .get(`/api/rooms/${room.roomId}/executions`)
        .set('Authorization', `Bearer ${tokenBob}`);

      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(2);

      const [latest, earlier] = res.body.runs;
      expect(latest).toMatchObject({
        id: objectId(11),
        language: 'python',
        status: 'timeout',
        timedOut: true,
        exitCode: 124,
        executionTimeMs: 5003,
        stderr: 'Execution timed out after 5000ms',
        triggeredBy: { id: userAlice.id, username: 'alice' },
      });
      expect(earlier).toMatchObject({ status: 'completed', timedOut: false, stdout: 'hi\n', exitCode: 0 });
      expect(latest.code).toBeUndefined();
    });

    it('returns an empty list when the room has no runs', async () => {
      runs = [];
      const res = await request(app)
        .get(`/api/rooms/${room.roomId}/executions`)
        .set('Authorization', `Bearer ${tokenAlice}`);

      expect(res.status).toBe(200);
      expect(res.body.runs).toEqual([]);
      expect(res.body.nextCursor).toBeNull();
    });

    it('rejects non-members with 403', async () => {
      const res = await request(app)
        .get(`/api/rooms/${room.roomId}/executions`)
        .set('Authorization', `Bearer ${tokenEve}`);

      expect(res.status).toBe(403);
      expect(res.body.runs).toBeUndefined();
      expect(captured).toBeNull();
    });

    it('rejects an oversized page with 400', async () => {
      const res = await request(app)
        .get(`/api/rooms/${room.roomId}/executions?limit=500`)
        .set('Authorization', `Bearer ${tokenAlice}`);
      expect(res.status).toBe(400);
    });
  });
});
