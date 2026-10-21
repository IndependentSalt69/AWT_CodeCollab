/**
 * Voice token API tests
 *
 * Validates:
 * - POST /api/rooms/:roomId/voice-token issues LiveKit tokens to room members only
 * - Token identity and voice room come from server state, not the request body
 * - Missing LiveKit configuration returns 503
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

const Room = require('../../database/models/Room');
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

const voiceEnv = {
  LIVEKIT_URL: 'wss://voice.example.test',
  LIVEKIT_API_KEY: 'test-api-key',
  LIVEKIT_API_SECRET: 'test-api-secret-value-for-voice-tokens',
};

describe('POST /api/rooms/:roomId/voice-token', () => {
  let app;

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
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  afterEach(() => {
    Object.keys(voiceEnv).forEach((key) => delete process.env[key]);
  });

  it('returns 503 when voice is not configured', async () => {
    const res = await request(app)
      .post(`/api/rooms/${room.roomId}/voice-token`)
      .set('Authorization', `Bearer ${tokenAlice}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Voice chat is not configured on this server');
    expect(res.body.token).toBeUndefined();
  });

  it('issues a short-lived LiveKit token bound to the verified user and room', async () => {
    Object.assign(process.env, voiceEnv);

    const res = await request(app)
      .post(`/api/rooms/${ROOM_OBJECT_ID}/voice-token`)
      .set('Authorization', `Bearer ${tokenBob}`)
      .send({ identity: userAlice.id, roomName: 'someone-elses-room' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      url: voiceEnv.LIVEKIT_URL,
      roomName: `codecollab-${room.roomId}`,
      identity: userBob.id,
      expiresIn: 600,
    });

    const claims = jwt.verify(res.body.token, voiceEnv.LIVEKIT_API_SECRET);
    expect(claims.iss).toBe(voiceEnv.LIVEKIT_API_KEY);
    expect(claims.sub).toBe(userBob.id);
    expect(claims.name).toBe('bob');
    expect(claims.video).toEqual({
      room: `codecollab-${room.roomId}`,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });
    expect(claims.exp - claims.nbf).toBeLessThanOrEqual(600);
    expect(JSON.stringify(res.body)).not.toContain(voiceEnv.LIVEKIT_API_SECRET);
  });

  it('rejects non-members with 403', async () => {
    Object.assign(process.env, voiceEnv);

    const res = await request(app)
      .post(`/api/rooms/${room.roomId}/voice-token`)
      .set('Authorization', `Bearer ${tokenEve}`);

    expect(res.status).toBe(403);
    expect(res.body.token).toBeUndefined();
  });

  it('rejects unauthenticated requests with 401', async () => {
    Object.assign(process.env, voiceEnv);
    const res = await request(app).post(`/api/rooms/${room.roomId}/voice-token`);
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown rooms', async () => {
    Object.assign(process.env, voiceEnv);
    const res = await request(app)
      .post('/api/rooms/missing-room/voice-token')
      .set('Authorization', `Bearer ${tokenAlice}`);
    expect(res.status).toBe(404);
  });
});
