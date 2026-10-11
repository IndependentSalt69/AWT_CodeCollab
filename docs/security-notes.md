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
  - Interim Batch 3 Limitation (Resolved in Section 11): During initial Batch 3 implementation, 8 random bytes (64 bits of entropy) were stored as plaintext without expiration timestamps. This interim state was fully resolved in Section 11: upgraded to 128 bits of entropy (16 bytes), SHA-256 cryptographic hashing at rest in MongoDB (`inviteHash`), 7-day expiration enforcement (`inviteExpiresAt`), and single-use return on creation/rotation.
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

## 9. Batch 3 Review Gates & Private Room Upgrades (M0.9)
- **128-Bit Cryptographic Invitation Entropy:**
  - Upgraded private-room invite code generation from 8 bytes (64 bits) to 16 random bytes (128 bits of cryptographic entropy) via `crypto.randomBytes(16).toString('hex')` (32 hex characters).
  - Applied across `createRoom`, `getRoomInvite`, and `rotateRoomInvite` in [`backend/src/services/roomService.js`](file:///d:/AWT_CodeCollab/backend/src/services/roomService.js).
- **Safe Comparison & Malformed Input Handling:**
  - `verifyInviteCode` defensively checks that both inputs are strings, normalizes them to lowercase buffers, ensures buffers are non-empty, and verifies buffer lengths are equal prior to calling `crypto.timingSafeEqual`.
  - Wrapped in a `try/catch` block that safely catches any unexpected parsing or decoding errors and returns `false` rather than throwing an unhandled exception or crashing the request.
- **Route Rate Limiting on Private Room Joins:**
  - Added dedicated `joinRoomLimiter` (`10` attempts per IP per minute in production, configurable via `RATE_LIMIT_JOIN_ROOM_MAX`) to prevent online brute-force guessing of private room tokens.
  - Mounted on both `POST /api/rooms/join` and `POST /api/rooms/:roomId/join` in [`backend/src/routes/rooms.js`](file:///d:/AWT_CodeCollab/backend/src/routes/rooms.js).
- **End-to-End React UI Workflow for Private Rooms:**
  - Room creation: Added `newRoomIsPrivate` checkbox in Create Room modal on [`frontend/src/pages/Dashboard/DashboardPage.tsx`](file:///d:/AWT_CodeCollab/frontend/src/pages/Dashboard/DashboardPage.tsx).
  - Immediate token distribution: Upon creating a private room, displays a dedicated modal showing the 128-bit invite code with a one-click copy button.
  - Room listing & privacy indicators: Private room cards display a prominent `🔒 Private` badge; room owners see an invite code row with a copy button and on-demand invite token fetching via `getRoomInvite`.
  - Joining private rooms: Join Room modal provides an explicit Invite Code input passed to `roomService.joinRoom`.

## 10. Batch 4: Infrastructure & Verification Hardening (M0.9)
- **SEC-INFRA-01 (Multi-Stage Docker Packaging & Service Isolation):**
  - `backend/Dockerfile`: Multi-stage build based on `node:20-alpine`. Builds production dependencies with `npm ci --omit=dev`, runs under the unprivileged `node` user, and includes a container healthcheck (`wget --spider http://127.0.0.1:5000/health`).
  - `frontend/Dockerfile`: Multi-stage build compiling TypeScript/Vite assets and serving static output via `nginx:alpine` on port 3000, configured with custom `frontend/nginx.conf` enforcing security headers and an active healthcheck.
  - Localhost interface binding: Host-published ports for MongoDB (`127.0.0.1:27017:27017`) and Redis (`127.0.0.1:6379:6379`) are bound strictly to `127.0.0.1`, preventing exposure to public host network interfaces.
  - Least-privilege MongoDB application user: `infrastructure/docker/mongo-init.js` creates a dedicated `codecollab_app` user restricted to database `codecollab` with `readWrite` role. The application no longer connects as root.
  - Safe environment templates: `.env.example` and `infrastructure/.env.example` committed with safe placeholders and explicit configuration documentation.
- **SEC-AUTH-01 (Startup Gate for Insecure JWT Secrets):**
  - In [`backend/src/middleware/auth.js`](file:///d:/AWT_CodeCollab/backend/src/middleware/auth.js), startup fails with a fatal error if `JWT_SECRET` is unset, empty, or matches known default keys (`dev_secret_key_12345`, `your_super_secret_jwt_key`, `secret`, `changeme`, etc.) when `NODE_ENV` is `production` or `staging`.
- **SEC-INFRA-02 (Docker Socket Trust Boundary & Execution Architecture):**
  - Public backend isolation: The public-facing `backend` service in [`infrastructure/docker-compose.yml`](file:///d:/AWT_CodeCollab/infrastructure/docker-compose.yml) does NOT mount `/var/run/docker.sock`.
  - Local execution profile: Docker socket access is restricted to a dedicated `execution-worker` service isolated behind Docker Compose profile `profiles: ["local-dev-execution"]`, with explicit security warnings documenting host-equivalent control risks.
  - Architecture decision for public deployment: Separating the execution worker into an isolated daemon backed by rootless Docker, gVisor, or Firecracker microVMs is recorded as an absolute prerequisite before public launch.
- **SEC-TEST-01 (Real Frontend React Component Test Suite):**
  - Implemented [`testing/frontend/react_components.test.jsx`](file:///d:/AWT_CodeCollab/testing/frontend/react_components.test.jsx) using React Testing Library and `jest-environment-jsdom`.
  - Exercises actual React components: `LoginPage`, `SignupPage`, `DashboardPage` (private room creation, badges, invite display, joining), and `Terminal` (idle, running, completed, failed, timeout, clear).
  - 20 / 20 tests passing against real mounted components.
- **Real MongoDB Integration Verification:**
  - Added opt-in integration suite in [`testing/integration/mongo_integration.test.js`](file:///d:/AWT_CodeCollab/testing/integration/mongo_integration.test.js) executable via `npm run test:integration:mongo`.
  - Safety guards reject remote URIs (Atlas, cloud, non-localhost).
  - Validates real unique indexes (E11000 duplicate keys), persistent room membership, and 128-bit private room invite enforcement against a disposable local database.
- **SEC-DEP-01 (Dependency Audit Posture):**
  - Ran fresh `npm audit`: patched `source-map-js` using non-breaking `npm audit fix`.
  - Audited remaining advisories: dev-only test dependencies (`micromatch` in Jest/nodemon, `sprintf-js` in Istanbul) and `dompurify` inside `monaco-editor`. No production remote code execution vulnerabilities exist in core server dependencies.

## 11. Final Pre-PR Security Hardening & Review Gate (M0.9)
- **Complete SHA-256 Invite Token Hashing at Rest (`SEC-ROOM-02`):**
  - Database schema in [`database/models/Room.js`](file:///d:/AWT_CodeCollab/database/models/Room.js) strictly omits `inviteCode`. Only `inviteHash: { type: String, trim: true, default: null }` and `inviteExpiresAt: { type: Date, default: null }` are stored. Zero plaintext invite tokens are persisted to MongoDB.
  - Hashing utility `hashInviteCode` computes SHA-256 digest (`crypto.createHash('sha256').update(code.trim().toLowerCase()).digest('hex')`).
  - `verifyInviteCode` requires a 64-character hex hash and verifies candidate tokens via constant-time comparison (`crypto.timingSafeEqual`).
  - Storage redaction: `sanitizeRoom` strictly omits `inviteHash` from all API representations; `inviteExpiresAt` is exposed so clients can observe token lifetimes. Plaintext `inviteCode` is returned only once when explicitly generated upon creation or rotation.
  - Endpoint Redesign: `GET /api/rooms/:roomId/invite` returns HTTP 400 Bad Request (`Plaintext invite tokens are hashed at rest and cannot be retrieved`), informing clients that one-way SHA-256 hashes cannot be reversed and directing them to call `POST /api/rooms/:roomId/invite/rotate`.
  - Frontend Workflow: In [`frontend/src/pages/Dashboard/DashboardPage.tsx`](file:///d:/AWT_CodeCollab/frontend/src/pages/Dashboard/DashboardPage.tsx), tokens are maintained in component state only long enough to display/copy. If an invite code is not cached in local memory, copying automatically invokes `rotateRoomInvite`, displays the newly generated 128-bit token in the notice modal, and writes it to the clipboard.
- **Explicit Expiration Authorization Enforcement:**
  - `joinRoom` explicitly checks token expiration (`new Date(room.inviteExpiresAt) < new Date()`) prior to accepting tokens, throwing HTTP 403 Forbidden (`Invite code has expired`).
  - Relies on synchronous authorization enforcement at request time rather than asynchronous TTL background deletion.
  - Token rotation immediately updates `inviteHash`, generates a fresh 128-bit token, and refreshes `inviteExpiresAt` to `now + 7 days`, immediately invalidating any prior invite token.
- **Test Teardown Cleanliness & Removal of `--forceExit`:**
  - Diagnosed open handle detected by Jest `--detectOpenHandles`: a hanging TCP socket from BullMQ `ExecutionQueue` instantiated during queue capacity testing in `testing/security/remediation_batch2.test.js`.
  - Added clean `afterAll` teardown hook invoking `executionQueue.close()`.
  - Successfully removed `--forceExit` flag from `package.json` `"test"` script. All 18 standard test suites complete and exit naturally with 0 open handles.
- **Verification Counts Reconciled:**
  - Standard Test Suite (`npm test`): Exactly **222 passed tests** across 18 passing suites (1 suite skipped: `testing/integration/mongo_integration.test.js` with 3 skipped tests due to safe default offline gating; total discovered: 19 suites, 225 tests).
  - Live MongoDB Integration Suite (`npm run test:integration:mongo`): Exactly **3 passed tests** across 1 suite against local disposable container (`127.0.0.1:27017`), executing the exact 3 integration tests skipped by default in the standard run.
  - Combined Verified Total: Exactly **225 passed tests** across 19 distinct suites with 0 failures across both modes.
- **Scoped Dependency Security Audit Posture (`npm audit` & `npm audit --omit=dev`):**
  - Production Backend Server (`backend/package.json`): **0 vulnerabilities.** All server runtime dependencies are clean; no backend HTTP routes, sockets, or execution pipelines are exposed.
  - Production Frontend Client Bundle (`frontend/package.json`): **2 Low severity vulnerabilities** in `dompurify` (<=3.4.15) bundled transitively via `monaco-editor` (`>=0.57.0-rc.2`) (GHSA-p98j-92pf-mc4p, GHSA-6688-9rhm-gjv2). Confined to client-side tooltip rendering; CodeCollab does not accept user HTML via DOMPurify hooks.
  - Development & Test Tooling (`devDependencies`): **35 vulnerabilities** (5 moderate, 30 high) in Jest/nodemon/Istanbul/Babel build tools; completely excluded from production container images and runtime environments. Total repository advisories: 37.

## 12. M1.0 Phase A: Backend-Worker Separation & Queue Decoupling
- **Architectural Decoupling (`SEC-EXEC-06`):**
  - **Public Backend Producer Isolation**: Completely removed `executionQueue.startWorker()` from [`backend/src/index.js`](file:///d:/AWT_CodeCollab/backend/src/index.js) and [`backend/src/services/executionService.js`](file:///d:/AWT_CodeCollab/backend/src/services/executionService.js). The public Express server and Socket.IO gateway no longer instantiate an in-process BullMQ worker or touch the Docker Remote API.
  - **Pure Queue Producer Boundary**: Decoupled `execution/engine/queue.js` and `backend/src/services/executionService.js` from Dockerode. Extracted memory and CPU parsing utilities into [`execution/engine/resourceLimits.js`](file:///d:/AWT_CodeCollab/execution/engine/resourceLimits.js). The backend loads zero Docker dependencies into memory.
  - **Standalone Execution Worker Entrypoint**: Created dedicated [`execution/worker/index.js`](file:///d:/AWT_CodeCollab/execution/worker/index.js) running as an independent process (`npm run start:worker`). It consumes jobs from Redis BullMQ queue (`codecollab-execution-queue`), manages the ephemeral Python sandbox, enforces bounded concurrency (2-4), sanitizes credentials in logs, and handles `SIGTERM`/`SIGINT` graceful shutdown.
- **Local Development Operation**:
  - Backend and worker run as separate processes via `npm run start:backend` and `npm run start:worker`, or via Docker Compose profile `docker compose --profile local-dev-execution up`.
  - In [`infrastructure/docker-compose.yml`](file:///d:/AWT_CodeCollab/infrastructure/docker-compose.yml), `execution-worker` runs `node execution/worker/index.js` and requires only `REDIS_URL`, dropping unnecessary `PORT=5001`, `MONGO_URI`, and `JWT_SECRET` access.
- **Remaining Security Limitations & Next Phase Requirement**:
  - **Host Docker Socket Boundary**: In local development and Phase A, the standalone `execution-worker` still connects to the host Docker daemon (`/var/run/docker.sock`). While the public backend is protected, a sandbox escape inside the worker could still access the host Docker daemon.
  - **Phase B Requirement**: Rootless Docker (`dockerd-rootless.sh` / `docker:dind-rootless`) and optional gVisor (`runsc`) must be implemented in Phase B before the execution subsystem is safe for public multi-tenant deployment.
- **Verification**:
  - Added [`testing/execution/worker.test.js`](file:///d:/AWT_CodeCollab/testing/execution/worker.test.js) (10 tests) and [`testing/security/backend_worker_isolation.test.js`](file:///d:/AWT_CodeCollab/testing/security/backend_worker_isolation.test.js) (7 tests).
  - Standard Test Suite (`npm test`): **239 passed tests** across 20 suites with 0 failures and 0 open handle leaks.

## 13. M1.0 Phase B: Rootless Execution Daemon & Runtime Isolation
- **Host Socket Elimination & Configurable Connectivity (`SEC-EXEC-07`):**
  - **Zero Host Socket Dependency**: Removed `/var/run/docker.sock` volume mount from `execution-worker` in [`infrastructure/docker-compose.yml`](file:///d:/AWT_CodeCollab/infrastructure/docker-compose.yml).
  - **Explicit Endpoint Resolution ([`execution/engine/dockerConfig.js`](file:///d:/AWT_CodeCollab/execution/engine/dockerConfig.js))**:
    - Supports `DOCKER_HOST` configuration for worker only.
    - Strictly blocks direct connections to `/var/run/docker.sock` unless `ALLOW_HOST_DOCKER_SOCKET=true` is set.
    - Rejects missing/empty `DOCKER_HOST` in worker/production environments without implicit fallback (`ALLOW_DEFAULT_DOCKER_FALLBACK=true` required for single-developer testing).
    - Rejects wildcard `0.0.0.0` TCP addresses, invalid ports, and unsupported URI schemes.
    - Supports user-scoped unprivileged Unix sockets (`unix:///run/user/<uid>/docker.sock`), TCP endpoints (`tcp://execution-daemon:2375`), and Windows named pipes (`npipe:////./pipe/docker_engine`).
- **Internal Docker Compose Network Hardening**:
  - `backend`, `frontend`, `mongo`, `redis` join `app-network` (`driver: bridge`).
  - `execution-daemon` (`docker:27-dind-rootless`) joins `execution-network` (`driver: bridge`, `internal: true`).
  - `execution-daemon` exposes **zero** published host ports.
  - The public backend is on `app-network` and has **zero** DNS or network access to `execution-daemon`.
  - `execution-worker` joins `app-network` (to consume BullMQ Redis jobs) and `execution-network` (to issue Docker API calls to `tcp://execution-daemon:2375`).
- **Optional gVisor (`runsc`) OCI Runtime Support**:
  - Validates `CONTAINER_RUNTIME`: supports `runc` and `runsc`.
  - When `CONTAINER_RUNTIME=runsc` is requested, `verifyRuntimeAvailable()` queries daemon capabilities via `docker.info()`.
  - If `runsc` is not registered in the daemon, it fails closed with an actionable error. It **never silently downgrades** to `runc`.
  - Runner container creation conditionally injects `Runtime: 'runsc'` into `HostConfig`.
- **Preserved Runner Container Boundaries & Output Math**:
  - `ReadonlyRootfs: true`, `CapDrop: ['ALL']`, `SecurityOpt: ['no-new-privileges:true']`.
  - `NetworkMode: 'none'`, `PidsLimit: 64`, `Memory: 256MB`, `NanoCPUs: 0.5`.
  - `Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=32m' }`.
  - **Output Buffer Bound**: Program output is capped at `MAX_OUTPUT_BUFFER_BYTES = 64 KiB` (65,536 bytes). When exceeded, the runner stream is aborted and a 40-byte marker (`\n[Output truncated: exceeded 64KB limit]`) is appended, resulting in a delivered payload of exactly 65,576 bytes.
  - **Zero socket mounts**: Verified that no runner container mounts `/var/run/docker.sock` or daemon credentials.
- **Resource Enforcement & Cgroup Driver Analysis**:
  - **Containerized DinD Limitation**: In `docker:27-dind-rootless`, dockerd reports `Cgroup Driver: none` because `/sys/fs/cgroup` is mounted read-only and no systemd user session manager runs inside Alpine Linux. Dockerd accepts resource flags without error, but per-container kernel OOM and PID limits are not enforced within DinD.
  - **Outer Boundary Mitigation**: In `infrastructure/docker-compose.yml`, the outer `execution-daemon` container is bounded by the host Docker daemon with `cpus: 1.0`, `mem_limit: 512m`, and `pids_limit: 128`, preventing host resource exhaustion.
  - **Production Architecture**: Genuine per-runner cgroup enforcement requires a dedicated host-level rootless Docker daemon running under an unprivileged user (e.g. `execution-user`) managed via `systemctl --user`, with systemd cgroup v2 controller delegation (`Delegate=cpu cpuset io memory pids` in `/etc/systemd/system/user@.service.d/delegate.conf`).
- **Outer-Daemon Seccomp Analysis**:
  - `docker:27-dind-rootless` requires `seccomp=unconfined` because Docker's default seccomp profile blocks `clone3` / `unshare(CLONE_NEWUSER | CLONE_NEWNS)` and mount operations needed by RootlessKit.
  - Dedicated host-level rootless Docker daemon eliminates this requirement, running directly on the host kernel where runner containers execute under Docker's default builtin seccomp profile.
## 14. M1.0 Final Resource-Enforcement Gate Review & Production Fail-Closed Posture
- **Production Fail-Closed Gate (`SEC-EXEC-08`):**
  - **Enforcement Policy**: In production (`NODE_ENV === 'production'`), staging, untrusted execution, unknown modes, or development without an explicit profile, `REQUIRE_CGROUP_ENFORCEMENT` defaults strictly to `true`.
  - **Strict Local-Development-Only Exception**: Setting `ALLOW_UNENFORCED_CGROUPS === 'true'` is accepted **ONLY** when the process is explicitly configured for the trusted local-development profile (`EXECUTION_PROFILE=local-dev-execution` or `local-dev-dind`) under `NODE_ENV=development` or `test`.
  - **Rejection Across All Non-Local Modes**: The override is strictly rejected for production, staging, untrusted execution, unknown deployment modes, and development without an explicit profile. `NODE_ENV=development` alone is **NOT** treated as proof that an execution environment is trusted.
  - **Preflight Gate Validation**: `validateWorkerPreflight()` in [`execution/worker/index.js`](file:///d:/AWT_CodeCollab/execution/worker/index.js) queries daemon capabilities on worker startup *before* accepting any BullMQ jobs. If cgroup enforcement fails, the worker process exits immediately with a fatal error; zero jobs are consumed.
  - **Multi-Vector Controller Verification**: Rather than relying solely on `CgroupDriver !== 'none'`, `verifyCgroupCapabilities()` validates:
    1. `CgroupDriver !== 'none'` and is non-empty.
    2. `MemoryLimit === true` (kernel memory cgroup controller active).
    3. `CPUShares === true` (relative CPU weight scheduling).
    4. `CpuCfsQuota === true` & `CpuCfsPeriod === true` (kernel CFS bandwidth controller — required for the hard 0.5-CPU cap via `NanoCPUs: 500000000`).
    5. `PidsLimit === true` (kernel PID controller active).
    6. Absence of rootless cgroup delegation warnings in `info.Warnings`.
  - **CFS Bandwidth Quota Requirement**: A daemon reporting `CPUShares: true` but `CpuCfsQuota: false` cannot enforce the 0.5-CPU hard limit. The gate fails closed in enforcement-required mode when CFS quota support is absent or false.
  - **Host Controller Caveat**: `docker info` flags are necessary capability advertisements from the daemon process, but are not sufficient proof of live host enforcement alone. Live controller availability on the production target host (`cat /sys/fs/cgroup/cgroup.controllers` showing `cpu`, `cpuset`, `memory`, `pids`) must also be satisfied.
  - If any controller is missing, the worker immediately logs a fatal error listing the specific missing controllers and terminates with exit code 1 without polling or executing jobs.
  - **Zero Silent Fallback**: The worker never falls back to workstation rootful Docker or unconfigured endpoints.

- **Environment Capability, Residual Risks & Remaining Blockers**:
  - **Containerized DinD Limitation**: In `docker:27-dind-rootless`, `CgroupDriver: none` and all resource controllers (`MemoryLimit`, `CPUShares`, `CpuCfsQuota`, `CpuCfsPeriod`, `PidsLimit`) report `false`. Per-runner kernel resource limits are non-functional in this mode. Outer container boundaries (`cpus: 1.0`, `mem_limit: 512m`, `pids_limit: 128`) and Node.js wall-clock timeouts (5s) provide defense-in-depth for local development.
  - **Outer-Daemon Seccomp Residual Risk**: `docker:27-dind-rootless` requires `seccomp=unconfined` because Docker's default seccomp profile denies user namespace creation and RootlessKit mount syscalls. Native host-level rootless Docker under systemd eliminates this risk, executing runners directly under default seccomp.
  - **Workstation Platform Limitation & Remaining Blocker**:
    - **No Live Host Rootless Daemon on Workstation**: The developer's Windows/WSL2 workstation contains only the `docker-desktop` appliance distribution (lacking systemd). A native host rootless daemon with cgroup delegation has **NOT** been live-verified on this machine.
    - **Public Multi-Tenant Execution Blocked**: Public untrusted execution remains strictly blocked until the production deployment target has demonstrated effective CPU, memory, and PID cgroup v2 controller delegation (`cat /sys/fs/cgroup/cgroup.controllers`) and the intended sandbox runtime (e.g. gVisor `runsc`) is registered and verified.
  - **Host Reachability & Socket Trust Boundary**:
    - Containerized workers must **never** connect to `tcp://127.0.0.1:2375` (loopback is container-scoped and unreachable).
    - In containerized Compose environments, the worker connects across `execution-network` to `tcp://execution-daemon:2375` (no published host ports).
    - For dedicated host-level rootless deployments, the narrowest defensible mechanism is bind-mounting the dedicated user UNIX socket (`/run/user/1001/docker.sock` -> `/var/run/execution/docker.sock`) with mode `0660` restricted to the execution group, avoiding exposed TCP ports entirely.
  - **Required Host / WSL2 Setup Commands**:
    ```bash
    sudo apt-get install -y uidmap dbus-user-session docker-ce-rootless-extras
    sudo mkdir -p /etc/systemd/system/user@.service.d
    echo -e "[Service]\nDelegate=cpu cpuset io memory pids" | sudo tee /etc/systemd/system/user@.service.d/delegate.conf
    sudo systemctl daemon-reload
    loginctl enable-linger execution-user
    dockerd-rootless-setuptool.sh install
    systemctl --user start docker
    ```

- **Reconciled Verification Totals (Exact Jest Assertion Counts)**:
  - **Full Standard Test Suite (`npm test`):** **278 passed**, **3 skipped**, **281 total** tests across **21 passed suites**, **1 skipped suite** (`mongo_integration.test.js` skipped by default); 0 failures.
  - **Exact Category Breakdown**:
    - `testing/security/`: **107 passed** across 5 suites (`rootless_daemon_runtime.test.js`: 37, `remediation_batch3.test.js`: 28, `remediation_batch2.test.js`: 18, `remediation_batch1.test.js`: 16, `backend_worker_isolation.test.js`: 8).
    - `testing/frontend/`: **52 passed** across 4 suites (`react_components.test.jsx`: 20, `execution_frontend.test.js`: 17, `auth_frontend.test.js`: 8, `room_frontend.test.js`: 7).
    - `testing/backend/`: **48 passed** across 3 suites (`auth.test.js`: 19, `rooms.test.js`: 17, `execute.test.js`: 12).
    - `testing/execution/`: **47 passed** across 4 suites (`execution.test.js`: 13, `python_runner.test.js`: 12, `queue.test.js`: 11, `worker.test.js`: 11).
    - `testing/realtime/`: **24 passed** across 5 suites (`editor_sync.test.js`: 8, `room_persistence.test.js`: 7, `driver.test.js`: 5, `sockets.test.js`: 3, `presence_activity.test.js`: 1).
    - `testing/integration/`: **0 passed, 3 skipped** in standard run (opt-in only).
    - **Sum**: 107 + 52 + 48 + 47 + 24 = **278 passed tests**.
  - **Separate Opt-In MongoDB Integration Suite (`npm run test:integration:mongo`):** **3 passed tests**, 0 failures against local disposable database.
  - **Frontend Production Build (`npm run build`):** Clean build via Vite (121 modules transformed, 0 errors).
  - **Compose Validation:** `docker compose --profile local-dev-execution config` passes cleanly.
