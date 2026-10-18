# Execution Engine & Runners

This directory houses the containerized code execution subsystem, Redis-backed execution queue, standalone execution worker, persistence, realtime event integration, and frontend terminal interface for CodeCollab.

## Architecture (M1.0 Phase B: Rootless Execution Daemon & Runtime Isolation)

```text
User Interface (Frontend React + Monaco Editor)
      ↓ (Driver clicks "Run Code")
Frontend Execution Service (services/executionService.ts -> POST /api/execute)
      ↓ (JWT Bearer Token + Driver Authorization via driverState.js)
ExecutionRun Document Created (database/models/ExecutionRun.js -> status: 'queued')
      ↓
Realtime Event Broadcast (io.to(roomId).emit('execution:started', { runId, status: 'queued', ... }))
      ↓
Public Backend API (Queue Producer ONLY - Attached to 'app-network')
[ZERO Dockerode / Socket Access, ZERO DNS/IP Access to Execution Daemon]
      ↓
BullMQ Execution Queue (queue.js: ExecutionQueue.execute())  <--->  Redis (REDIS_URL / app-network)
      │
══════╪════════════════════════════════════════════════════════════════════════════════════════════
      │ [Process & Network Trust Boundary]
      ▼
Standalone Execution Worker (execution/worker/index.js - Attached to 'app-network' & 'execution-network')
[No host /var/run/docker.sock mount; connects strictly via DOCKER_HOST to isolated daemon]
      ↓ (Bounded Concurrency: 2–4 workers)
Execution Engine (executeCode.js)
      ↓
Isolated Dockerode Client (executor.js + dockerConfig.js)
      ↓ (DOCKER_HOST=tcp://execution-daemon:2375 or unix:///run/user/<uid>/docker.sock)
══════╪════════════════════════════════════════════════════════════════════════════════════════════
      │ [Internal Network Boundary: execution-network (internal: true)]
      ▼
Rootless Execution Daemon (docker:27-dind-rootless or host systemd user dockerd)
[Unprivileged UID 1000 user namespace; no published host ports; internal bridge only]
      ↓ (Optional OCI Runtime: CONTAINER_RUNTIME=runsc for gVisor Sentry sandbox)
Ephemeral Container Creation (HostConfig: Memory 256MB, NanoCPUs 500M, Network 'none', PidsLimit 64)
[ReadonlyRootfs: true, CapDrop: ALL, no-new-privileges: true, ZERO socket mounts]
      ↓
Multiplexed Stream Attachment (demux stdout / stderr with 64KB caps)
      ↓
Dynamic Container Execution (codecollab-runner-python:latest via --code)
      ↓
Timeout Monitor (Race: container.wait() vs 5000ms setTimeout SIGKILL)
      ↓
Result Parser (resultParser.js -> stdout, stderr, exitCode, executionTimeMs, status)
      ↓
Ephemeral Container Cleanup (container.remove({ force: true }))
      ↓
Job Result Returned to BullMQ in Redis
══════╪════════════════════════════════════════════════════════════════════════════════════════════
      ▼
Public Backend Resolves Job (job.waitUntilFinished via Redis QueueEvents)
      ↓
ExecutionRun Document Updated (status: 'completed' | 'failed' | 'timeout', stdout, stderr, exitCode, executionTimeMs)
      ↓
Realtime Event Broadcast (io.to(roomId).emit('execution:completed' | 'execution:failed', { runId, ... }))
      ↓
Frontend Terminal Output Component (components/terminal/Terminal.tsx -> renders live status, stdout, stderr, duration, exit code)
```

---

## 1. Engine & Worker Subsystem

- `worker/index.js` — **Standalone Execution Worker entrypoint (M1.0 Phase A)**. Independently consumes jobs from Redis BullMQ queue, respects concurrency bounds (2-4), executes user submissions via Docker sandbox, sanitizes credentials in logs, and handles `SIGTERM`/`SIGINT` graceful shutdown.
- `executeCode.js` — Main execution entry point invoked by the worker. Validates language/code specifications and coordinates sandboxed execution.
- `executor.js` — Real Dockerode-based container orchestrator. Ephemerally provisions containers, enforces resource constraints, demultiplexes streams, handles timeouts, and guarantees container destruction.
- `resourceLimits.js` — Pure utility module for memory string-to-bytes and CPU-to-NanoCPUs parsing without importing Dockerode. Used by both the API validation service and sandbox executor.
- `dockerConfig.js` — **Isolated Execution Daemon & Runtime Configuration (M1.0 Phase B)**. Parses and validates `DOCKER_HOST` endpoints (TCP, rootless unix sockets, named pipes), blocks direct connection to host `/var/run/docker.sock` unless explicitly opted in, validates container runtimes (`runc`, `runsc`), and verifies gVisor (`runsc`) registration on the daemon without silent downgrades.
- `queue.js` — Redis + BullMQ asynchronous job queue. Coordinates FIFO execution, bounded concurrency (2–4 simultaneous jobs), failure isolation, and lifecycle management. Decoupled from the executor so queue producers do not load Dockerode.
- `resultParser.js` — Normalizes stdout, stderr, execution time, and process exit code into a structured result object (`status`: `'completed'`, `'failed'`, or `'timeout'`).
- `sandboxConfig.js` — Default resource configuration (CPU: 0.5, Memory: 256MB, Timeout: 5000ms, Network: disabled).

---

## 2. API & Realtime Integration (M0.5d / M1.0 Phase A)

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

## 5. Docker Container Sandboxing & Security (M0.9 Hardened)

Each code run is executed inside an ephemeral container configured with the following authoritative isolation parameters:
- **Memory Ceiling:** 256 MiB (`Memory: 268435456`, `MemorySwap: 268435456`). Client overrides exceeding 256 MiB are rejected with HTTP 400.
- **Timeout Ceiling:** Default 5,000 ms, hard maximum 10,000 ms. Client overrides exceeding 10,000 ms are rejected with HTTP 400.
- **CPU Quota:** 0.5 CPU core (`NanoCPUs: 500000000`).
- **Network Isolation:** Fully disabled (`NetworkMode: 'none'`). Outbound connections and port scans are blocked.
- **Process / Fork Bomb Limit:** 64 processes max (`PidsLimit: 64`).
- **Read-Only Root Filesystem:** `ReadonlyRootfs: true`. User processes cannot mutate system or application directories.
- **Linux Capabilities Dropped:** `CapDrop: ['ALL']`. Container retains zero root capabilities.
- **Privilege Escalation Blocked:** `SecurityOpt: ['no-new-privileges:true']`.
- **Restricted Tmpfs Mount:** `Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=32m' }`. Explicit writable scratchpad mounted with `noexec` and `nosuid`.
- **Bounded Output Buffering:** 64 KiB retained limit per stream (stdout/stderr). When exceeded, container is killed immediately, output is truncated with `\n[Output truncated: exceeded 64KB limit]`, and execution fails with exit code 137 without hanging or leaking memory.
- **Submitted Code Size Limit:** 64 KiB UTF-8 source code maximum. Enforced in API validation (400), execution engine, and realtime editor sync.
- **BullMQ Backlog Admission Control:** Queue capacity capped at 25 waiting jobs (`MAX_WAITING_JOBS = 25`). Rejects excess admissions with HTTP 429 (`QUEUE_CAPACITY_EXCEEDED`).
- **Unprivileged User:** Executes as `USER sandbox` (UID 1000). Runner code in `/app` is owned by `root:root` with read-and-execute-only permissions (`chmod -R 555 /app`).
- **Safe Payload Delivery:** Direct argument passing (`Cmd: ['--code', code]`) over the Docker Remote API without shell interpolation.
- **Ephemeral Teardown:** Immediate `container.remove({ force: true })` in the execution `finally` block ensuring zero lingering containers.

---

## 6. Python 3.11 Dynamic Runner (`execution/runners/python/`)

The Python 3.11 runner executes dynamic user-submitted code in an unbuffered environment under an unprivileged `sandbox` user with a read-only root filesystem. Bytecode caching is explicitly directed to `/tmp` via `ENV PYTHONPYCACHEPREFIX=/tmp`.

### Input Methods Supported
1. **CLI Flag `--code`**: `python runner.py --code "print('hello')"` (used by Dockerode orchestrator).
2. **CLI File Argument**: `python runner.py /path/to/script.py`.
3. **Environment Variable `SUBMISSION_FILE`**: `SUBMISSION_FILE=/path/to/script.py python runner.py`.
4. **Default Mount Path**: Looks for `/app/submission.py`, `/app/submission/code.py`, or `./submission.py`.
5. **Environment Variable `SUBMISSION_CODE`**: `SUBMISSION_CODE="print('hello')" python runner.py`.

### Output & Exit Codes
- **`stdout`**: Captured directly with unbuffered stream forwarding (`PYTHONUNBUFFERED=1` / `-u`). Capped at 64 KiB.
- **`stderr`**: Unhandled exceptions, tracebacks, and syntax errors are output directly to `stderr`. Capped at 64 KiB.
- **`exitCode`**: Propagates the exact process return code from user code (e.g. `sys.exit(0)` -> `0`, uncaught exception -> `1`, `sys.exit(42)` -> `42`, output limit kill -> `137`, timeout -> `124`).

### Building the Docker Image
```bash
docker build -t codecollab-runner-python:latest execution/runners/python
```

---

## 7. Other Language Runners (`execution/runners/`)

- `cpp/` — GCC 13, C++17. Compiles fixed `main.cpp` and runs the generated binary.
- `java/` — Eclipse Temurin JDK 17. Compiles fixed `Main.java`; provide `public class Main` with `public static void main(String[] args)` in the default package. Other public class names, packages, or missing entry points return compiler/runtime diagnostics. User filenames, JVM flags, and class paths are not accepted.
- `compiled_runner.py` — shared trusted launcher; uses argument arrays without a shell, runs compiler and program as UID 1000, and terminates the process group after each phase. Container removal is the final cleanup boundary, including descendants that create new sessions.

Both compiled languages use the existing API, BullMQ worker, Dockerode executor and result schema. `stderr` carries compiler diagnostics and runtime exceptions; nonzero exit codes produce `failed`. The existing 5-second default / 10-second maximum timeout includes **compilation and execution together**. A timeout kills the whole container; it is not a fresh budget for each phase.

The 64 KiB source/output limits, 256 MiB memory ceiling, 0.5 CPU quota, 64 PID limit, disabled networking, read-only root filesystem, dropped capabilities and no-new-privileges policy remain. A 32 MiB `/work` tmpfs holds source and compiler outputs. C++ requires `exec` on this mount to run its binary; it retains `nosuid,nodev,mode=700`. Java's `/work` and every runner's `/tmp` remain `noexec`. Java uses a 96 MiB heap, SerialGC, one active processor and bounded stack/metaspace/code cache; these settings do not replace cgroup enforcement.

Build from the shared runner context:

```bash
docker build -t codecollab-runner-cpp:latest -f execution/runners/cpp/Dockerfile execution/runners
docker build -t codecollab-runner-java:latest -f execution/runners/java/Dockerfile execution/runners
```

`start.ps1` builds all three images, saves and loads them into the inner execution daemon, verifies each image there, then starts the worker. Building only on Docker Desktop does not make an image available to that daemon. On a native Linux target, build/load all three images into the dedicated rootless daemon before starting its worker. Missing images fail closed; there is no host compiler fallback.

See [the 2026-10-18 implementation and verification report](../docs/execution-security-cpp-java-report.md). The release remains `NOT_QUALIFIED_FOR_PRODUCTION`.

---

## 8. Operating Backend, Worker, and Rootless Daemon (M1.0 Phase B)

Following the M1.0 Phase B isolation hardening, the execution worker connects strictly to an isolated rootless execution daemon:

### Option A: Docker Compose with Isolated Rootless Execution Daemon (Recommended)
```bash
# Starts backend, frontend, mongo, redis, execution-daemon (rootless), and execution-worker
docker compose -f infrastructure/docker-compose.yml --profile local-dev-execution up -d
```
- **Network Boundaries:**
  - `backend`, `frontend`, `mongo`, `redis` attach to `app-network`.
  - `execution-daemon` attaches strictly to `execution-network` (`driver: bridge`, `internal: true`). Exposes **zero** published host ports.
  - `execution-worker` attaches to `app-network` (to consume BullMQ jobs from Redis) and `execution-network` (to issue Docker API commands to `tcp://execution-daemon:2375`).
  - The public `backend` has **zero** DNS or IP connectivity to `execution-daemon`.
  - The host `/var/run/docker.sock` is **never mounted** into any container.

### Option B: Local Standalone Worker with Dedicated Host Rootless Daemon (Linux)
On Linux hosts running Docker Rootless under a dedicated unprivileged user (`dockerd-rootless.sh`):
1. **Ensure Rootless Dockerd is Running:**
### Option B: Dedicated Host-Level Rootless Daemon (Production & Strict Isolation)
For multi-tenant or untrusted execution with genuine kernel cgroup v2 resource limits (CPU shares, memory OOM killer, PID limits):
1. **Host Prerequisites**:
   - Linux host or WSL2 distribution with systemd enabled (`[boot] systemd=true`).
   - cgroup v2 controller delegation enabled: `/etc/systemd/system/user@.service.d/delegate.conf` (`Delegate=cpu cpuset io memory pids`).
   - Dedicated unprivileged user: `execution-user` (UID 1001, GID 1001).
   - Rootless dockerd managed under systemd: `systemctl --user start docker`.
2. **Worker Reachability & Trust Boundary**:
   - **Containerized Worker**: Mount the dedicated user socket into the worker container:
     `/run/user/1001/docker.sock:/var/run/execution/docker.sock` with `0660` permissions.
     Set `DOCKER_HOST=unix:///var/run/execution/docker.sock`.
     *(WARNING: Do NOT configure containerized workers to connect to `tcp://127.0.0.1:2375`; loopback is container-scoped and unreachable).*
   - **Native Host Worker**: Run worker directly as a systemd unit or node process under `execution-user`:
     `DOCKER_HOST=unix:///run/user/1001/docker.sock npm run start:worker`.
3. **Fail-Closed Enforcement**:
   - In production (`NODE_ENV=production`), `REQUIRE_CGROUP_ENFORCEMENT` defaults strictly to `true`.
   - The worker preflight validates all six kernel capability vectors: `CgroupDriver !== 'none'`, `MemoryLimit`, `CPUShares` (relative scheduling weight), `CpuCfsQuota` (hard 0.5-CPU cap via CFS bandwidth control), `CpuCfsPeriod`, and `PidsLimit`.
   - **CFS Quota Requirement**: A daemon that reports `CPUShares: true` but `CpuCfsQuota: false` cannot enforce the runner's 0.5-CPU cap (`NanoCPUs: 500000000`); the preflight detects this and fails closed.
   - **Production Bypass Prevention**: Setting `ALLOW_UNENFORCED_CGROUPS=true` in production (`NODE_ENV=production`) is explicitly rejected with a fatal error; the worker refuses to accept or execute untrusted code.
   - **Host Controller Caveat**: `docker info` flags represent daemon capability advertisements. Genuine enforcement requires that the underlying host kernel actually delegates the controllers (`cpu`, `cpuset`, `memory`, `pids`) to the user session (`/sys/fs/cgroup/cgroup.controllers`). Info flags are necessary but not sufficient proof of live host enforcement.

### Option C: Local Developer Testing with Platform Fallback
For single-developer local testing against the local Docker engine (e.g. Docker Desktop on Windows/macOS):
```bash
# Allows fallback to platform default (Windows named pipe or local socket)
ALLOW_DEFAULT_DOCKER_FALLBACK=true npm run start:worker
```
*Direct connection to `/var/run/docker.sock` is blocked by default; if required for local debugging, pass `ALLOW_HOST_DOCKER_SOCKET=true`.*

### Configuration & Environment Variables
- `REDIS_URL`: Redis connection string (e.g. `redis://localhost:6379`). Credentials automatically redacted in logs.
- `DOCKER_HOST`: Isolated daemon endpoint (`tcp://execution-daemon:2375` or `unix:///run/user/1001/docker.sock`).
- `CONTAINER_RUNTIME`: Optional OCI container runtime. Set to `runsc` for gVisor Sentry isolation. Defaults to `runc`. Fails closed if `runsc` is requested but not registered.
- `REQUIRE_CGROUP_ENFORCEMENT`: Require genuine kernel cgroup controller enforcement (CPU quota, Memory, PIDs). Defaults to `true` (fail-closed) for production, staging, untrusted execution, unknown modes, and development without an explicit profile.
- `EXECUTION_PROFILE`: Explicit execution profile name (e.g. `local-dev-execution` or `local-dev-dind`). Required for the trusted local-development exception.
- `ALLOW_UNENFORCED_CGROUPS`: Trusted local-development-only override. **Accepted ONLY when `EXECUTION_PROFILE=local-dev-execution` under `NODE_ENV=development` or `test`**. Strictly REJECTED for production, staging, untrusted execution, and unknown deployment modes. `NODE_ENV=development` alone is NOT trusted.
- `ALLOW_HOST_DOCKER_SOCKET`: Explicit boolean opt-in required to allow connection to `/var/run/docker.sock` (development debugging only).
- `ALLOW_DEFAULT_DOCKER_FALLBACK`: Explicit boolean opt-in allowing fallback to platform Docker engine when `DOCKER_HOST` is unset.
- `EXECUTION_CONCURRENCY`: Worker concurrency bound (default: `2`, target: `2–4`).

---

## 9. Security Boundary Posture, Residual Risks & Remaining Blockers

> [!NOTE]
> **PHASE B SECURITY POSTURE:**
> 1. **Zero Host Socket Dependency:** The execution worker never mounts or relies on the privileged `/var/run/docker.sock`.
> 2. **Network Isolation:** The rootless daemon runs on an internal, un-routed network (`execution-network`) with zero public host ports.
> 3. **Backend Privilege Separation:** The public backend has no Docker dependencies, socket mounts, or network access to the daemon.
> 4. **Container Hardening Retained:** Ephemeral runner containers retain read-only root filesystems, all capabilities dropped (`CapDrop: ['ALL']`), `no-new-privileges: true`, 256MB RAM / 0.5 CPU / 64 PID limits, `network: none`, and zero daemon socket mounts.
> 5. **Fail-Closed Runtime & Cgroup Selection:** If `CONTAINER_RUNTIME=runsc` or `REQUIRE_CGROUP_ENFORCEMENT=true` is requested, the system verifies daemon capabilities and fails closed with an actionable error rather than silently degrading isolation.
> 6. **Local-Development-Only Exception:** `ALLOW_UNENFORCED_CGROUPS=true` is accepted only under `EXECUTION_PROFILE=local-dev-execution` in development/test. It is rejected for production, staging, untrusted execution, and unknown deployment modes.

### Residual Risks & Remaining Production Blockers
1. **Containerized DinD Cgroup Limitation:** In the local Docker Compose development profile (`docker:27-dind-rootless`), `Cgroup Driver: none` is reported because Alpine init has no systemd user session manager and `/sys/fs/cgroup` is mounted read-only. Per-runner CPU, memory, and PID limits are not enforced by the kernel in this mode. Defense-in-depth relies on outer container boundaries (`cpus: 1.0`, `mem_limit: 512m`, `pids_limit: 128`), Node.js wall-clock timeouts (5s), and output buffer truncation (64KB).
2. **Outer Daemon Seccomp Residual Risk:** `docker:27-dind-rootless` requires `seccomp=unconfined` because Docker's default seccomp profile denies user namespace creation and RootlessKit mount syscalls. Native host-level rootless Docker under systemd eliminates this risk, executing runners directly under default seccomp.
3. **Workstation Platform Limitation & Production Blocker:**
   - **No Live Host Rootless Daemon on Workstation:** The developer's Windows/WSL2 environment uses Docker Desktop's appliance distro (no systemd user session manager). A native host-level rootless daemon has NOT been live-verified on this machine.
   - **Public Untrusted Execution Blocker:** Public multi-tenant execution remains blocked until the production deployment target has demonstrated effective CPU, memory, and PID cgroup v2 controller delegation (`cat /sys/fs/cgroup/cgroup.controllers`) and the intended sandbox runtime (e.g. gVisor `runsc`) is registered and verified.
   - Host setup commands for production target:
     ```bash
     sudo apt-get install -y uidmap dbus-user-session docker-ce-rootless-extras
     sudo mkdir -p /etc/systemd/system/user@.service.d
     echo -e "[Service]\nDelegate=cpu cpuset io memory pids" | sudo tee /etc/systemd/system/user@.service.d/delegate.conf
     sudo systemctl daemon-reload
     loginctl enable-linger execution-user
     dockerd-rootless-setuptool.sh install
     systemctl --user start docker
     ```
4. **gVisor Availability:** On Windows and standard Docker Desktop environments, gVisor (`runsc`) is not registered by default. CodeCollab detects this capability and defaults to `runc` for trusted local development while preventing silent downgrades when `runsc` is explicitly configured. Multi-tenant production clusters must have gVisor installed and registered in `daemon.json`.

---

## 10. Reconciled Verification Totals (Exact Jest Output)

- **Full Standard Test Suite (`npm test`):**
  - **278 passed**, **3 skipped**, **281 total** tests across **21 passed suites**, **1 skipped suite** (`mongo_integration.test.js` skipped by default in standard run); 0 failures.
  - **Reconciled Category Breakdown (Exact Jest Assertion Counts):**
    - `testing/security/`: **107 passed** across 5 suites (`rootless_daemon_runtime.test.js`: 37, `remediation_batch3.test.js`: 28, `remediation_batch2.test.js`: 18, `remediation_batch1.test.js`: 16, `backend_worker_isolation.test.js`: 8).
    - `testing/frontend/`: **52 passed** across 4 suites (`react_components.test.jsx`: 20, `execution_frontend.test.js`: 17, `auth_frontend.test.js`: 8, `room_frontend.test.js`: 7).
    - `testing/backend/`: **48 passed** across 3 suites (`auth.test.js`: 19, `rooms.test.js`: 17, `execute.test.js`: 12).
    - `testing/execution/`: **47 passed** across 4 suites (`execution.test.js`: 13, `python_runner.test.js`: 12, `queue.test.js`: 11, `worker.test.js`: 11).
    - `testing/realtime/`: **24 passed** across 5 suites (`editor_sync.test.js`: 8, `room_persistence.test.js`: 7, `driver.test.js`: 5, `sockets.test.js`: 3, `presence_activity.test.js`: 1).
    - `testing/integration/`: **0 passed, 3 skipped** in standard run (opt-in only).
    - **Sum:** 107 + 52 + 48 + 47 + 24 = **278 passed tests**.
- **Separate Opt-In MongoDB Integration Suite (`npm run test:integration:mongo`):**
  - **3 passed tests**, 0 failures against local disposable database.
- **Frontend Production Build (`npm run build`):**
  - `tsc && vite build`: 121 modules transformed, 0 errors.
- **Docker Compose Validation:**
  - `docker compose -f infrastructure/docker-compose.yml --profile local-dev-execution config`: Validated cleanly with zero syntax or network errors.
