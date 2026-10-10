# CodeCollab Security Specification & Notes

## 1. Authentication & Password Security
- **Password Hashing:** Passwords are hashed using `bcryptjs` with salt rounds = 10 prior to persistence. Plaintext passwords are never logged, stored, or emitted in responses.
- **User Enumeration Prevention:** `POST /api/auth/login` uses generic invalid-credentials responses (`Invalid username/email or password`) with HTTP 401. It does not disclose whether a requested username or email exists in the database.
- **Duplicate Registration Protection:** Registration enforces unique constraints on both `username` and `email`, returning HTTP 409 Conflict when duplicates are attempted.

## 2. JWT Configuration & Secrets Management
- **Secret Isolation:** `JWT_SECRET` is read from `process.env.JWT_SECRET`. In production environments (`NODE_ENV === 'production'`), startup immediately throws a critical security error if `JWT_SECRET` is unset, preventing the use of fallback development keys.
- **Expiration Policy:** Tokens are issued with a 24-hour expiration (`expiresIn: '24h'`).
- **Token Claims:** Payload claims contain `{ userId, id, username, email }`. Sensitive attributes like password hashes are strictly excluded.
- **Client Security:** Secrets are never exposed to browser bundles. Browser stores the bearer token in `localStorage` and supplies it via `Authorization: Bearer <token>`.

## 3. Realtime Socket.IO Identity Binding
- **Handshake Verification:** Sockets connecting to the realtime server provide `socket.handshake.auth.token` or `socket.handshake.headers.authorization`. Server-side middleware verifies the signature using `jwt.verify(token, getJwtSecret())`.
- **Verified Socket Identity:** On successful verification, the socket session stores `socket.data.verifiedUser`. Unverified connections or tokens with invalid signatures have `socket.data.verifiedUser = null`.
- **Anti-Spoofing:** When joining a room (`room:join`), client-supplied user objects are overridden with the verified user profile if an authenticated token is bound.

## 4. Fail-Closed Driver Authorization Edge Case
- **The Vulnerability Addressed:** In earlier audits, a room driver socket could exist without authenticated user metadata, or a caller could supply a driver socket ID while presenting a different user's JWT.
- **The Fail-Closed Defense:** `executionService.js` enforces three strict verification levels:
  1. **Active Driver Check:** The provided `socketId` (or caller) must match the room's current active driver socket (`403 Forbidden`).
  2. **Verified Identity Check:** The driver socket MUST have a verified identity (`socket.data.verifiedUser` or `socket.data.roomVerifiedUsers`). If the driver socket has missing or unauthenticated metadata, authorization fails closed (`403 Forbidden: Driver session is not authenticated with a verified user identity`).
  3. **Identity Match Check:** The caller's JWT user identity (`userId` / `username`) must match the driver socket's verified user identity. If mismatched, execution is forbidden (`403 Forbidden: Authenticated user does not match the active room driver session`).

## 5. Room Authorization & Fail-Closed Access Control (M0.8)
- **Pre-Join Authorization Gate:** In `realtime/server/rooms.js`, room authorization is evaluated before `socket.join(roomId)` is ever called. Unauthorized, unauthenticated, non-member, or unknown room requests are rejected immediately, preventing sockets from receiving room events, code sync broadcasts, or chat.
- **Fail-Closed on Database Connection Failures:** When MongoDB is disconnected or service is unavailable, authorization fails closed with `{ ok: false, error: 'Database connection error: service unavailable' }`. Database disconnects never produce an authorization bypass or fall back to unrestricted legacy joining.
- **Database Error Resilience:** If a database query throws an unexpected error (timeout, network drop), it is caught and rejected with `{ ok: false, error: 'Database error occurred during room authorization' }`, rather than silently succeeding or being misreported as a 404.
- **Non-Existent Rooms:** Unknown rooms return `{ ok: false, error: 'Room not found' }` and terminate without joining the socket.
- **Verified Membership Enforcement:** Sockets attempting to join a database-backed room must have verified JWT identity metadata. Sockets without authentication or with malformed metadata (missing user ID) are rejected with `{ ok: false, error: 'Authentication required to join this room' }`. Authenticated users who are neither the room owner nor in the room's persistent `members` array are rejected with `{ ok: false, error: 'Access denied: You are not a member of this room' }`.
- **Membership Immutability via Socket Events:** Disconnecting or leaving a live Socket.IO room updates only ephemeral in-memory state (`driverState` and Socket.IO adapters). Database membership documents and arrays are never mutated by socket disconnects.