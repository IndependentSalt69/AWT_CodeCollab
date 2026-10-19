const jwt = require('jsonwebtoken');

// Voice tokens only need to be valid long enough to connect
const VOICE_TOKEN_TTL_SECONDS = 10 * 60;

/**
 * Reads LiveKit settings from the environment. Returns null when voice is not configured.
 */
function getVoiceConfig() {
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!url || !apiKey || !apiSecret) {
    return null;
  }
  return { url, apiKey, apiSecret };
}

/**
 * Maps a CodeCollab room to its LiveKit voice room name.
 */
function getVoiceRoomName(roomId) {
  return `codecollab-${roomId}`;
}

/**
 * Issues a short-lived LiveKit access token for a verified room member.
 * The identity and room come from server-side state, never from the client.
 *
 * LiveKit access tokens are HS256 JWTs signed with the API secret
 * (iss = API key, sub = participant identity, video = room grant).
 */
function createVoiceToken({ roomId, userId, username }) {
  const config = getVoiceConfig();
  if (!config) {
    const error = new Error('Voice chat is not configured on this server');
    error.status = 503;
    throw error;
  }

  const identity = String(userId);
  const roomName = getVoiceRoomName(roomId);

  const token = jwt.sign(
    {
      name: username || identity,
      video: {
        room: roomName,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
      },
    },
    config.apiSecret,
    {
      algorithm: 'HS256',
      issuer: config.apiKey,
      subject: identity,
      jwtid: identity,
      notBefore: 0,
      expiresIn: VOICE_TOKEN_TTL_SECONDS,
    }
  );

  return {
    token,
    url: config.url,
    roomName,
    identity,
    expiresIn: VOICE_TOKEN_TTL_SECONDS,
  };
}

module.exports = {
  createVoiceToken,
  getVoiceConfig,
  getVoiceRoomName,
  VOICE_TOKEN_TTL_SECONDS,
};
