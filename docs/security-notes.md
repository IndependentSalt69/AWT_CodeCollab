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

## 6. Remediation Batch 1 Hardening (M0.9)
- **SEC-CHAT-01 (Chat Authorization & Anti-Spoofing):**
  - Verified room membership: Enforces dual socket room checks (`socket.rooms.has(roomId)` and `socket.data.roomMemberships.has(roomId)`). Non-members receive `{ ok: false, error: 'Sender is not a member of the room' }` and broadcasts are blocked.
  - Verified identity derivation: Senders must possess a verified token; identities are extracted exclusively from server session state (`socket.data.roomVerifiedUsers.get(roomId)` or `socket.data.verifiedUser`). Client-supplied `user`, `sender`, or `userId` payload properties are ignored.
  - Payload length limits: Chat messages are capped at 2,000 characters (`MAX_MESSAGE_LENGTH`). Oversized or malformed payloads are rejected.
  - Contract preservation: Preserves compatible wire events (`chat:message_send`, `chat:message_received`).

- **SEC-REALTIME-02 (Presence & Typing Authorization & Isolation):**
  - Room membership validation: Both `presence.js` and `typing.js` reject emissions from sockets that have not joined the specified room.
  - Verified identity relay: Presence statuses (`presence:status`, `presence:ping`) and typing indicators (`typing:start`, `typing:stop`) derive user metadata from verified socket session state, discarding client-supplied identity claims.
  - Status whitelisting: `presence:status` validates status values against an allowed set (`['online', 'away', 'busy', 'offline']`).
  - Transient state cleanup: On `room:leave` or disconnect, per-socket membership and driver states are cleaned up without leaking into persistent storage.

- **SEC-ROOM-01 (Removal of Room Authorization Test Bypass & Strict Fail-Closed):**
  - Elimination of mock hooks: Removed `Boolean(Room.findOne && Room.findOne.mock)` and `isDbConfigured` bypasses from `realtime/server/rooms.js`.
  - Unconditional fail-closed: All room join attempts require verified JWT authentication, an active database connection (`mongoose.connection.readyState === 1`), and valid persistent room membership or ownership.
  - Resilient error handling: Unknown rooms return `{ ok: false, error: 'Room not found' }`; disconnected databases return `{ ok: false, error: 'Database connection error: service unavailable' }`; query exceptions return `{ ok: false, error: 'Database error occurred during room authorization' }`.
  - Explicit test mocking: Test suites mock database boundaries cleanly (`jest.spyOn(Room, 'findOne')` and explicit connection readyState) rather than altering production authorization logic.

- **SEC-AUTH-03 (Driver Identity Immutable ID Enforcement):**
  - Strict immutable ID matching: `backend/src/services/executionService.js` compares `driverUserId` with `reqUserId` using immutable MongoDB identifiers.
  - Removal of username fallback: Completely eliminated `nameMatch` fallback (`driverUsername === reqUsername`). Identical usernames with mismatched user IDs are rejected with HTTP 403 Forbidden (`Authenticated user does not match the active room driver session`).

## 7. Remediation Batch 2: Sandbox & Resource Hardening (M0.9)
- **SEC-EXEC-01 (Bound Execution Resource Overrides):**
  - Authoritative execution policy:
    - Default timeout: 5,000 ms (`DEFAULT_TIMEOUT_MS`).
    - Maximum timeout: 10,000 ms (`MAX_TIMEOUT_MS`).
    - Maximum container memory: 256 MiB (`MAX_MEMORY_BYTES = 256 * 1024 * 1024`).
    - CPU limit: 0.5 CPU (`NanoCPUs: 500000000`).
    - Networking disabled (`NetworkMode: 'none'`).
    - PID limit: 64 (`PidsLimit: 64`).
  - API service validation: `validateExecutionRequest` rejects requests exceeding 10,000 ms timeout or 256 MiB memory with HTTP 400 Bad Request, as well as zero, negative, or malformed units.
  - Defensive engine boundary: `runInSandbox` in `executor.js` clamps timeout to 10,000 ms and memory to 256 MiB to prevent internal callers from bypassing bounds.
  - Safe memory parser: `parseMemoryToBytes` handles standard units (`m`, `g`, `k`, raw bytes) and returns `null` for negative numbers, NaN, or malformed strings.
- **SEC-EXEC-02 (Bound Stdout/Stderr Buffering):**
  - Buffer limit: 64 KiB (`MAX_OUTPUT_BUFFER_BYTES = 64 * 1024`) per stream.
  - UTF-8 byte tracking: Tracks streamed data in UTF-8 bytes (`Buffer.byteLength`) rather than JavaScript character counts.
  - Immediate container termination: When retained output exceeds 64 KiB, the container is killed immediately, streams stop accumulating, and output is truncated with `\n[Output truncated: exceeded 64KB limit]`.
  - Non-blocking drainage: Backpressure is avoided by safely closing container streams on termination.
  - Ephemeral container cleanup: Container removal is guaranteed in `finally` blocks (`container.remove({ force: true })`).
  - Outcome classification: Output limit termination yields `status: 'failed'`, `exitCode: 137`, `timedOut: false`, and `outputLimitExceeded: true`, correctly differentiated from timeouts.
- **SEC-EXEC-03 (Hardened Runner Containers):**
  - Docker HostConfig hardening:
    - `ReadonlyRootfs: true`: Root filesystem mounted read-only.
    - `CapDrop: ['ALL']`: All Linux capabilities dropped.
    - `SecurityOpt: ['no-new-privileges:true']`: Privilege escalation disabled.
    - `Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=32m' }`: Explicit writable scratchpad mounted with `noexec` and `nosuid`.
  - Runner filesystem permissions:
    - `/app` owned by `root:root` with read-and-execute-only permissions (`chmod -R 555 /app`).
    - Python bytecode caching routed to `/tmp` via `ENV PYTHONPYCACHEPREFIX=/tmp`.
    - User code executes as unprivileged user `sandbox` (UID 1000).
- **SEC-EXEC-04 (Limit Submitted Code Size):**
  - Maximum code size: 64 KiB UTF-8 (`MAX_CODE_SIZE_BYTES = 64 * 1024` = 65,536 bytes).
  - Consistent enforcement:
    - Backend execution request validation: Rejects submissions > 64 KiB with HTTP 400.
    - Execution engine: Defensive check in `executeCode` throws if byte length exceeds 64 KiB.
    - Realtime editor synchronization: `editorSync.js` checks byte length on `editor:change` and rejects oversized updates without broadcasting to peers.
  - Multibyte Unicode tracking: Uses `Buffer.byteLength(code, 'utf8')` to prevent attacks where character length < 64K but byte length exceeds limits.
- **SEC-EXEC-05 (Bound BullMQ Execution Backlog):**
  - Maximum waiting backlog: 25 jobs (`MAX_WAITING_JOBS = 25`).
  - Admission control: `executeCodeService` and `queue.add()` verify queue capacity (`getLength()` / `getWaitingCount()`) prior to accepting new jobs.
  - Proper HTTP error mapping: Backlog capacity errors reject with HTTP 429 (`QUEUE_CAPACITY_EXCEEDED`) and user-readable message: `Execution queue is at capacity (max 25 jobs waiting). Please retry shortly.`
  - Worker resilience: Capacity errors do not crash workers or alter FIFO job handling for active queue runs.

## 8. Remediation Batch 3: API Hardening & Access Control (M0.9)
- **SEC-ROOM-02 (Private-Room Join Protection & Cryptographic Invitations):**
  - Privacy enforcement: `roomService.joinRoom` checks `room.isPrivate`. Non-members and non-owners cannot join private rooms by simply knowing or guessing the room slug.
  - Cryptographic invite tokens: When private rooms are created, a 16-character hex invite code is generated via `crypto.randomBytes(8).toString('hex')`.
  - Timing-safe verification: Invite codes are compared using `crypto.timingSafeEqual` in `verifyInviteCode`, eliminating side-channel timing attacks on invite verification.
  - Confidentiality of secrets: `sanitizeRoom` withholds `inviteCode` from public lists (`GET /api/rooms`), ordinary details (`GET /api/rooms/:roomId`), and join responses. Only the creator receives the initial code on creation, or the owner via dedicated invite endpoints.
  - Owner-only rotation and retrieval: `GET /api/rooms/:roomId/invite` and `POST /api/rooms/:roomId/invite/rotate` permit the verified room owner to view or rotate the invite code; requests from non-owners return HTTP 403 Forbidden.
  - Backward compatibility: Public rooms continue to allow joining without an invite code. Room owners and existing authorized members retain seamless, idempotent access.
  - Outstanding Review Item & Non-Production Limitation: The current implementation generates 8 random bytes (64 bits of entropy) stored as plaintext on the Room document without expiration timestamps (TTL), scoped access, or single-use limits. While this successfully eliminates the open-join vulnerability (`SEC-ROOM-02`) and provides timing-safe verification for milestone M0.9, it must NOT be represented as production-ready. Production hardening will require higher entropy (>= 128 bits), cryptographic hashing at rest (e.g. SHA-256), expiration dates, and per-user invitation tokens.
- **SEC-API-01 (Route Rate Limiting):**
  - Independent route limits applied via `express-rate-limit`:
    - `POST /api/auth/login`: 5 attempts per IP per minute (configurable via `RATE_LIMIT_LOGIN_MAX`).
    - `POST /api/auth/register`: 5 attempts per IP per minute (configurable via `RATE_LIMIT_REGISTER_MAX`).
    - `POST /api/execute`: 20 requests per IP per minute (configurable via `RATE_LIMIT_EXECUTE_MAX`).
  - Response contract: Rejections return HTTP 429 with sanitized envelope `{ ok: false, error: ... }` and standard RFC/IETF draft headers (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`). Legacy `X-RateLimit-*` headers are disabled.
  - Anti-spoofing configuration: Express `trust proxy` is disabled by default. Client IP is resolved from socket remote address (`req.ip`), preventing attackers from bypassing limits via spoofed `X-Forwarded-For` headers.
  - Multi-instance limitation: Relies on in-memory `MemoryStore` per Node.js process. In multi-replica clustered environments, limits are local per replica unless backed by an external distributed store (e.g., Redis).
- **SEC-API-02 (Security Headers & Global Error Handling):**
  - Security headers via `helmet`: Mounted before routes, adding `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `X-DNS-Prefetch-Control: off`, and stripping `X-Powered-By`. Configured with `contentSecurityPolicy: false` and `crossOriginResourcePolicy: { policy: 'cross-origin' }` to preserve frontend asset loading and CORS compatibility.
  - Global sanitized error handling: Mounted as the final Express middleware (`(err, req, res, next)`).
  - Preserves intentional 4xx client statuses (400, 401, 403, 404, 409, 429).
  - Sanitizes unexpected 500 exceptions into a uniform `{ ok: false, error: 'Internal server error' }`, concealing file paths, stack traces, database exceptions, and cluster URLs. Diagnostic error logs are captured server-side with authorization headers and credentials redacted.
- **SEC-AUTH-02 (Account Enumeration & Auth Timing Mitigation):**
  - Unified registration conflict response: Both existing username and existing email return generic HTTP 409 Conflict with message `"Username or email is already registered"`.
  - Race condition handling: MongoDB unique index duplicate key errors (`code: 11000` / `codeName: 'DuplicateKey'`) are caught and mapped to the same generic 409 response.
  - Authentication timing mitigation: For nonexistent user lookups in `loginUser`, a dummy bcrypt comparison is executed against a module-level precomputed hash (`DUMMY_PASSWORD_HASH`) using cost factor 10, equalizing password-hashing computational work and mitigating account enumeration via login response latency.