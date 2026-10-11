/**
 * Live MongoDB Integration Test Suite (SEC-TEST-01 / SEC-PERSIST-01)
 *
 * SAFETY REQUIREMENTS:
 * - NEVER run against remote Atlas demo or teammate shared databases.
 * - Gated behind explicit opt-in environment flag: RUN_MONGO_INTEGRATION=true.
 * - Strict URL validation ensures connection string points exclusively to localhost / 127.0.0.1.
 * - Uses isolated, disposable test database dropped completely upon test completion.
 */

const mongoose = require('mongoose');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const User = require('../../database/models/User');
const Room = require('../../database/models/Room');
const roomService = require('../../backend/src/services/roomService');
const authService = require('../../backend/src/services/authService');

const RUN_MONGO_INTEGRATION = process.env.RUN_MONGO_INTEGRATION === 'true';

function validateLocalTestUri(uri) {
  if (!uri || typeof uri !== 'string') {
    throw new Error('FATAL SAFETY GUARD: MONGO_TEST_URI is not defined.');
  }

  const forbiddenIndicators = [
    'mongodb.net',
    'atlas',
    'azure',
    'aws',
    'cluster',
    'remote',
    'production',
  ];

  const lowerUri = uri.toLowerCase();
  for (const indicator of forbiddenIndicators) {
    if (lowerUri.includes(indicator)) {
      throw new Error(
        `FATAL SAFETY GUARD: Target URI contains prohibited remote indicator '${indicator}'. Real integration tests will NOT touch remote or production databases.`
      );
    }
  }

  const isLocalhost = lowerUri.includes('127.0.0.1') || lowerUri.includes('localhost');
  if (!isLocalhost) {
    throw new Error(
      'FATAL SAFETY GUARD: Test target is not 127.0.0.1 or localhost. Execution aborted.'
    );
  }
}

const describeIntegration = RUN_MONGO_INTEGRATION ? describe : describe.skip;

describeIntegration('Live MongoDB Integration Verification (Disposable Local Instance)', () => {
  let disposableDbName;
  let testConnectionUri;
  let localMongoAvailable = false;

  beforeAll(async () => {
    const rawUri = process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27017';
    validateLocalTestUri(rawUri);

    disposableDbName = `codecollab_test_disposable_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    try {
      const parsedUrl = new URL(rawUri);
      parsedUrl.pathname = `/${disposableDbName}`;
      testConnectionUri = parsedUrl.toString();
    } catch (_) {
      testConnectionUri = `${rawUri.replace(/\/$/, '')}/${disposableDbName}`;
    }

    try {
      await mongoose.connect(testConnectionUri, {
        serverSelectionTimeoutMS: 3000,
      });
      localMongoAvailable = true;

      // Ensure indexes are built in the real MongoDB engine
      await User.init();
      await Room.init();
    } catch (err) {
      console.warn(`[Integration Skipped] Could not connect to local MongoDB at ${rawUri}: ${err.message}`);
      localMongoAvailable = false;
    }
  }, 15000);

  afterAll(async () => {
    if (localMongoAvailable && mongoose.connection.readyState === 1) {
      try {
        await mongoose.connection.db.dropDatabase();
      } catch (err) {
        console.warn(`Failed to drop disposable database ${disposableDbName}:`, err.message);
      }
      await mongoose.disconnect();
    }
  });

  it('enforces real unique indexes for username and email uniqueness (E11000)', async () => {
    if (!localMongoAvailable) return;

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash('Password123!', salt);

    const user1 = new User({
      username: 'integration_user_alpha',
      email: 'alpha@test.local',
      passwordHash,
    });
    await user1.save();

    expect(user1._id).toBeDefined();

    // 1. Duplicate username collision
    let usernameError;
    try {
      const dupUser = new User({
        username: 'integration_user_alpha',
        email: 'different@test.local',
        passwordHash,
      });
      await dupUser.save();
    } catch (err) {
      usernameError = err;
    }

    expect(usernameError).toBeDefined();
    expect(usernameError.code).toBe(11000); // MongoDB duplicate key error code

    // 2. Duplicate email collision
    let emailError;
    try {
      const dupEmail = new User({
        username: 'different_user_name',
        email: 'alpha@test.local',
        passwordHash,
      });
      await dupEmail.save();
    } catch (err) {
      emailError = err;
    }

    expect(emailError).toBeDefined();
    expect(emailError.code).toBe(11000);
  });

  it('persists real room documents, handles membership mutations and idempotent joins', async () => {
    if (!localMongoAvailable) return;

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash('Password123!', salt);

    const ownerUser = new User({
      username: 'room_owner_live',
      email: 'room_owner@test.local',
      passwordHash,
    });
    await ownerUser.save();

    const memberUser = new User({
      username: 'room_member_live',
      email: 'room_member@test.local',
      passwordHash,
    });
    await memberUser.save();

    // Create room via roomService
    const created = await roomService.createRoom(
      { name: 'Persistent Integration Room', language: 'python', isPrivate: false },
      ownerUser._id
    );

    expect(created.roomId).toBeDefined();
    expect(created.name).toBe('Persistent Integration Room');
    expect(created.members.length).toBe(1);

    // Verify document exists in real database
    const dbDoc = await Room.findOne({ roomId: created.roomId });
    expect(dbDoc).not.toBeNull();
    expect(String(dbDoc.owner)).toBe(String(ownerUser._id));

    // Join room with new member
    const joined = await roomService.joinRoom(created.roomId, memberUser._id);
    expect(joined.members.length).toBe(2);

    // Verify mutation was persisted to MongoDB
    const updatedDoc = await Room.findOne({ roomId: created.roomId });
    expect(updatedDoc.members.map(String)).toContain(String(memberUser._id));

    // Idempotent join does not duplicate member in database
    await roomService.joinRoom(created.roomId, memberUser._id);
    const idempotentDoc = await Room.findOne({ roomId: created.roomId });
    expect(idempotentDoc.members.length).toBe(2);
  });

  it('persists 128-bit private room invite codes and enforces rotation in real MongoDB', async () => {
    if (!localMongoAvailable) return;

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash('Password123!', salt);

    const ownerUser = new User({
      username: 'private_owner_live',
      email: 'private_owner@test.local',
      passwordHash,
    });
    await ownerUser.save();

    const guestUser = new User({
      username: 'private_guest_live',
      email: 'private_guest@test.local',
      passwordHash,
    });
    await guestUser.save();

    // Create private room
    const privateRoom = await roomService.createRoom(
      { name: 'Secret Architecture Lab', language: 'python', isPrivate: true },
      ownerUser._id
    );

    expect(privateRoom.isPrivate).toBe(true);
    expect(privateRoom.inviteCode).toBeDefined();
    expect(privateRoom.inviteCode.length).toBeGreaterThanOrEqual(32); // 128 bits = 32 hex chars

    // Check raw document in database: raw plaintext token is strictly absent; only SHA-256 hash is persisted
    const rawDoc = await Room.findOne({ roomId: privateRoom.roomId });
    expect(rawDoc.inviteCode).toBeUndefined();
    expect(rawDoc.inviteHash).toBe(roomService.hashInviteCode(privateRoom.inviteCode));
    expect(rawDoc.inviteExpiresAt).toBeInstanceOf(Date);

    // Sanitized detail queries do NOT expose the invite code to members
    const details = await roomService.getRoomDetails(privateRoom.roomId, ownerUser._id);
    expect(details.inviteCode).toBeUndefined();
    expect(details.inviteHash).toBeUndefined();

    // Guest cannot join without invite code
    let joinWithoutCodeErr;
    try {
      await roomService.joinRoom(privateRoom.roomId, guestUser._id);
    } catch (err) {
      joinWithoutCodeErr = err;
    }
    expect(joinWithoutCodeErr).toBeDefined();
    expect(joinWithoutCodeErr.status).toBe(403);

    // Guest cannot join with invalid code
    let invalidCodeErr;
    try {
      await roomService.joinRoom(privateRoom.roomId, guestUser._id, { inviteCode: 'invalid_code' });
    } catch (err) {
      invalidCodeErr = err;
    }
    expect(invalidCodeErr).toBeDefined();
    expect(invalidCodeErr.status).toBe(403);

    // Guest joins with valid code
    const successfulJoin = await roomService.joinRoom(privateRoom.roomId, guestUser._id, {
      inviteCode: privateRoom.inviteCode,
    });
    expect(successfulJoin.members.map(m => String(m.id || m._id || m))).toContain(String(guestUser._id));

    // Owner rotates invite code
    const rotatedCode = await roomService.rotateRoomInvite(privateRoom.roomId, ownerUser._id);
    expect(rotatedCode).toBeDefined();
    expect(rotatedCode.length).toBeGreaterThanOrEqual(32);
    expect(rotatedCode).not.toBe(privateRoom.inviteCode);

    // Verify rotated code persisted in MongoDB as SHA-256 hash only, not plaintext
    const reloadedDoc = await Room.findOne({ roomId: privateRoom.roomId });
    expect(reloadedDoc.inviteCode).toBeUndefined();
    expect(reloadedDoc.inviteHash).toBe(roomService.hashInviteCode(rotatedCode));
    expect(reloadedDoc.inviteExpiresAt).toBeInstanceOf(Date);

    // Previous code is rejected for any new guests
    const newGuestUser = new User({
      username: 'second_guest_live',
      email: 'second_guest@test.local',
      passwordHash,
    });
    await newGuestUser.save();

    let oldCodeErr;
    try {
      await roomService.joinRoom(privateRoom.roomId, newGuestUser._id, { inviteCode: privateRoom.inviteCode });
    } catch (err) {
      oldCodeErr = err;
    }
    expect(oldCodeErr).toBeDefined();
    expect(oldCodeErr.status).toBe(403);
  });
});
