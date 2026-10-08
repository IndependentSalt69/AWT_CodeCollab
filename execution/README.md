# Execution Engine & Runners

This directory houses the containerized code execution subsystem and Redis-backed execution queue for CodeCollab.

## Architecture (M0.5c)

```text
Code Submission
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
Job Result Propagation (job.waitUntilFinished / event stream)
```

---

## 1. Engine (`execution/engine/`)

- `executeCode.js` — Main execution entry point. Validates language/code specifications and coordinates sandboxed execution.
- `executor.js` — Real Dockerode-based container orchestrator. Ephemerally provisions containers, enforces resource constraints, demultiplexes streams, handles timeouts, and guarantees container destruction.
- `queue.js` — Redis + BullMQ asynchronous job queue. Coordinates FIFO execution, bounded concurrency (2–4 simultaneous jobs), failure isolation, and lifecycle management.
- `resultParser.js` — Normalizes stdout, stderr, execution time, and process exit code into a structured result object (`status`: `'completed'`, `'failed'`, or `'timeout'`).
- `sandboxConfig.js` — Default resource configuration (CPU: 0.5, Memory: 256MB, Timeout: 5000ms, Network: disabled).

---

## 2. Redis + BullMQ Queue & Worker Architecture (M0.5c)

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

## 3. Docker Container Sandboxing & Security (M0.5b)

Each code run is executed inside an ephemeral container configured with the following isolation parameters:
- **Memory Limit:** 256 MB (`Memory: 268435456`, `MemorySwap: 268435456`)
- **CPU Quota:** 0.5 CPU core (`NanoCPUs: 500000000`)
- **Network Isolation:** Fully disabled (`NetworkMode: 'none'`)
- **Process / Fork Bomb Limit:** 64 processes max (`PidsLimit: 64`)
- **Unprivileged User:** Executes as `USER sandbox` (UID 1000)
- **Safe Payload Delivery:** Direct argument passing (`Cmd: ['--code', code]`) over the Docker Remote API without shell interpolation
- **Ephemeral Teardown:** Immediate `container.remove({ force: true })` in the execution `finally` block ensuring zero lingering containers

---

## 4. Python 3.11 Dynamic Runner (`execution/runners/python/`)

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

## 5. Other Language Runners (`execution/runners/`)

- `java/` — OpenJDK 17 runner *(placeholder skeleton; orchestration scheduled for future milestone)*.
- `cpp/` — GCC 13 runner *(placeholder skeleton; orchestration scheduled for future milestone)*.

---

## 6. Verification Status (M0.5c)

- **Redis + BullMQ Queue:** Verified with Redis 7 container on port 6379.
- **Queue Test Suite:** `testing/execution/queue.test.js` (11/11 passing).
- **Dockerode Orchestrator Tests:** `testing/execution/execution.test.js` (13/13 passing).
- **Python Runner Unit Tests:** `testing/execution/python_runner.test.js` (12/12 passing).
- **Full Test Suite:** 54/54 tests passing across all backend, realtime, and execution modules.

### Local Verification Steps
1. Start Redis:
   ```bash
   docker compose -f infrastructure/docker-compose.yml up -d redis
   ```
2. Run Execution & Queue Tests:
   ```bash
   npx jest testing/execution/
   ```
3. Run Full Test Suite:
   ```bash
   npx jest
   ```

---

## 7. Known Limitations (M0.5c)

- **C++ and Java Runners:** Remain static placeholders. Invoking non-Python languages in `executeCode` or queue throws an unsupported language error.
- **Backend API & Socket Integration:** REST API endpoint (`POST /api/execute`) and Socket.IO execution events are scheduled for M0.5d.
- **Frontend Terminal UI:** Output display component is scheduled for M0.5e.


