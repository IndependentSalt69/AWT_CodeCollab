# Execution Engine & Runners

This directory houses the containerized code execution subsystem, Redis-backed execution queue, persistence, realtime event integration, and frontend terminal interface for CodeCollab.

## Architecture (M0.5e)

```text
User Interface (Frontend React + Monaco Editor)
      ↓ (Driver clicks "Run Code")
Frontend Execution Service (services/executionService.ts -> POST /api/execute)
      ↓ (JWT Bearer Token + Driver Authorization via driverState.js)
ExecutionRun Document Created (database/models/ExecutionRun.js -> status: 'queued')
      ↓
Realtime Event Broadcast (io.to(roomId).emit('execution:started', { runId, status: 'queued', ... }))
      ↓
BullMQ Execution Queue (queue.js)  <--->  Redis (REDIS_URL / localhost:6379)
      ↓
Worker Pool (Bounded Concurrency: 2–4 workers)
      ↓
Execution Engine (executeCode.js)
      ↓
Dockerode Sandbox Orchestrator (executor.js)
      ↓
Ephemeral Container Creation (HostConfig: Memory 256MB, NanoCPUs 500M, Network 'none', PidsLimit 64)
      ↓
Multiplexed Stream Attachment (demux stdout / stderr)
      ↓
Dynamic Container Execution (codecollab-runner-python:latest via --code)
      ↓
Timeout Monitor (Race: container.wait() vs 5000ms setTimeout SIGKILL)
      ↓
Result Parser (resultParser.js -> stdout, stderr, exitCode, executionTimeMs, status)
      ↓
Ephemeral Container Cleanup (container.remove({ force: true }))
      ↓
Job Result Propagation (job.waitUntilFinished)
      ↓
ExecutionRun Document Updated (status: 'completed' | 'failed' | 'timeout', stdout, stderr, exitCode, executionTimeMs)
      ↓
Realtime Event Broadcast (io.to(roomId).emit('execution:completed' | 'execution:failed', { runId, ... }))
      ↓
Frontend Terminal Output Component (components/terminal/Terminal.tsx -> renders live status, stdout, stderr, duration, exit code)
```

---

## 1. Engine (`execution/engine/`)

- `executeCode.js` — Main execution entry point. Validates language/code specifications and coordinates sandboxed execution.
- `executor.js` — Real Dockerode-based container orchestrator. Ephemerally provisions containers, enforces resource constraints, demultiplexes streams, handles timeouts, and guarantees container destruction.
- `queue.js` — Redis + BullMQ asynchronous job queue. Coordinates FIFO execution, bounded concurrency (2–4 simultaneous jobs), failure isolation, and lifecycle management.
- `resultParser.js` — Normalizes stdout, stderr, execution time, and process exit code into a structured result object (`status`: `'completed'`, `'failed'`, or `'timeout'`).
- `sandboxConfig.js` — Default resource configuration (CPU: 0.5, Memory: 256MB, Timeout: 5000ms, Network: disabled).

---

## 2. API & Realtime Integration (M0.5d)

- **HTTP Route (`POST /api/execute`):**
  - Authenticated via JWT bearer token (`backend/src/middleware/auth.js`).
  - Strict driver authorization: verified using `realtime/server/driverState.js`. Rejects non-drivers with `403 Forbidden` and non-existent rooms with `404 Not Found`.
- **Database Persistence (`database/models/ExecutionRun.js`):**
  - Persists full execution lifecycle: `queued` → `completed` | `failed` | `timeout`.
  - Captures `roomId`, `triggeredBy`, `language`, `code`, `stdout`, `stderr`, `exitCode`, `executionTimeMs`, and `status`.
- **Realtime Broadcasts (`io.to(roomId)`):**
  - `execution:started` — emitted when code execution is validated and queued.
  - `execution:completed` — emitted when code runs successfully with exit code 0.
  - `execution:failed` — emitted when code fails, returns a non-zero exit code, or times out.
  - Strictly isolated to the specific room members.

---

## 3. Frontend Terminal & Run Code Action (M0.5e)

- **Terminal Component (`frontend/src/components/terminal/Terminal.tsx`):**
  - Live status badge: `Ready`, `Queued`, `Running...`, `Completed`, `Failed`, `Timeout`.
  - Distinguishable `stdout` (monospace white) and `stderr` (monospace red/rose).
  - Execution duration metric (`executionTimeMs`) and exit code badge.
  - Clear button and graceful handling of empty output.
- **Run Code Control (`frontend/src/App.tsx`):**
  - Active Driver can trigger Python execution in isolated container.
  - Disabled for Viewers with informative tooltip and badge.
  - Prevents accidental duplicate submissions while execution is in progress.
  - Surfaces backend validation and authentication errors clearly in the terminal.
- **Realtime Synchronization:**
  - Room members (Driver and Viewers) receive synchronized `execution:started`, `execution:completed`, and `execution:failed` updates.
  - Strict room isolation ensures other rooms cannot tamper with the active terminal.

---

## 4. Redis + BullMQ Queue & Worker Architecture (M0.5c)

- **Job Queue (`EXECUTION_QUEUE_NAME = 'codecollab-execution-queue'`):**
  - Connects to Redis using `REDIS_URL` (default: `redis://localhost:6379`).
  - Accepts execution job payload: `{ language, code, timeout, memory, roomId, userId, enqueuedAt }`.
- **Worker Concurrency & Rate Limiting:**
  - Configurable worker concurrency (default `2`, target `2–4`).
  - Limits simultaneous running Docker containers to avoid host CPU/memory starvation.
  - Preserves FIFO job ordering.
- **Worker Resiliency & Error Isolation:**
  - User code syntax errors, runtime exceptions, and container timeouts resolve with structured failure results (`status: 'failed'` / `'timeout'`) rather than throwing unhandled exceptions or crashing the worker.
  - Safe error event listeners prevent worker crashes on network blips.
- **Lifecycle & Graceful Teardown:**
  - `startWorker()` initializes the processing loop.
  - `close()` cleanly drains and shuts down workers, queues, and event listeners.
  - `ping()` performs quick health checks against the Redis instance.

---

## 5. Docker Container Sandboxing & Security (M0.5b)

Each code run is executed inside an ephemeral container configured with the following isolation parameters:
- **Memory Limit:** 256 MB (`Memory: 268435456`, `MemorySwap: 268435456`)
- **CPU Quota:** 0.5 CPU core (`NanoCPUs: 500000000`)
- **Network Isolation:** Fully disabled (`NetworkMode: 'none'`)
- **Process / Fork Bomb Limit:** 64 processes max (`PidsLimit: 64`)
- **Unprivileged User:** Executes as `USER sandbox` (UID 1000)
- **Safe Payload Delivery:** Direct argument passing (`Cmd: ['--code', code]`) over the Docker Remote API without shell interpolation
- **Ephemeral Teardown:** Immediate `container.remove({ force: true })` in the execution `finally` block ensuring zero lingering containers

---

## 6. Python 3.11 Dynamic Runner (`execution/runners/python/`)

The Python 3.11 runner executes dynamic user-submitted code in an unbuffered environment under an unprivileged `sandbox` user.

### Input Methods Supported
1. **CLI Flag `--code`**: `python runner.py --code "print('hello')"` (used by Dockerode orchestrator).
2. **CLI File Argument**: `python runner.py /path/to/script.py`.
3. **Environment Variable `SUBMISSION_FILE`**: `SUBMISSION_FILE=/path/to/script.py python runner.py`.
4. **Default Mount Path**: Looks for `/app/submission.py`, `/app/submission/code.py`, or `./submission.py`.
5. **Environment Variable `SUBMISSION_CODE`**: `SUBMISSION_CODE="print('hello')" python runner.py`.

### Output & Exit Codes
- **`stdout`**: Captured directly with unbuffered stream forwarding (`PYTHONUNBUFFERED=1` / `-u`).
- **`stderr`**: Unhandled exceptions, tracebacks, and syntax errors are output directly to `stderr`.
- **`exitCode`**: Propagates the exact process return code from user code (e.g. `sys.exit(0)` -> `0`, uncaught exception -> `1`, `sys.exit(42)` -> `42`).

### Building the Docker Image
```bash
docker build -t codecollab-runner-python:latest execution/runners/python
```

---

## 7. Other Language Runners (`execution/runners/`)

- `java/` — OpenJDK 17 runner *(placeholder skeleton; editor preview only)*.
- `cpp/` — GCC 13 runner *(placeholder skeleton; editor preview only)*.

---

## 8. Verification Status (M0.5e)

- **Frontend Terminal Integration Tests:** `testing/frontend/execution_frontend.test.js` (17/17 passing).
- **Execution API Integration Tests:** `testing/backend/execute.test.js` (12/12 passing).
- **Redis + BullMQ Queue Tests:** `testing/execution/queue.test.js` (11/11 passing).
- **Dockerode Orchestrator Tests:** `testing/execution/execution.test.js` (13/13 passing).
- **Python Runner Unit Tests:** `testing/execution/python_runner.test.js` (12/12 passing).
- **Realtime Collaboration Tests:** `testing/realtime/` (12/12 passing).
- **Backend Auth & Room Tests:** `testing/backend/` (6/6 passing).
- **Full Test Suite:** 83/83 tests passing across all 11 suites.
- **Frontend TypeScript & Production Build:** `tsc && vite build` succeeded (0 errors).

### Local Verification Steps
1. Start Redis:
   ```bash
   docker compose -f infrastructure/docker-compose.yml up -d redis
   ```
2. Run Execution & Queue Tests:
   ```bash
   npx jest testing/execution/
   ```
3. Run Backend API Tests:
   ```bash
   npx jest testing/backend/
   ```
4. Run Frontend Tests:
   ```bash
   npx jest testing/frontend/
   ```
5. Run Full Test Suite:
   ```bash
   npx jest --forceExit
   ```
6. Build Frontend:
   ```bash
   npm run build --workspace frontend
   ```

---

## 9. Known Limitations (M0.5e)

- **C++ and Java Runners:** Remain editor preview modes only. Container execution is active for Python 3.11.
- **Frontend Authentication Flow:** Full multi-page login/signup and JWT session store are scheduled for a dedicated milestone. The Terminal UI cleanly handles 401 errors and supports developer token entry via `localStorage.getItem('token')`.
- **Single-File Execution:** Code payloads currently execute as single-file dynamic scripts.
