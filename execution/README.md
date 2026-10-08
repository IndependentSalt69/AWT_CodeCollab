# Execution Engine & Runners

This directory houses the containerized code execution subsystem for CodeCollab.

## Architecture (M0.5b)

```text
Code Submission (executeCode.js)
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
```

---

## 1. Engine (`execution/engine/`)

- `executeCode.js` — Main execution entry point. Validates language/code specifications and coordinates sandboxed execution.
- `executor.js` — Real Dockerode-based container orchestrator. Ephemerally provisions containers, enforces resource constraints, demultiplexes streams, handles timeouts, and guarantees container destruction.
- `queue.js` — Asynchronous job queue interface *(in-memory stub; Redis + BullMQ integration targeted for M0.5c)*.
- `resultParser.js` — Normalizes stdout, stderr, execution time, and process exit code into a structured result object (`status`: `'completed'`, `'failed'`, or `'timeout'`).
- `sandboxConfig.js` — Default resource configuration (CPU: 0.5, Memory: 256MB, Timeout: 5000ms, Network: disabled).

---

## 2. Docker Container Sandboxing & Security (M0.5b)

Each code run is executed inside an ephemeral container configured with the following isolation parameters:
- **Memory Limit:** 256 MB (`Memory: 268435456`, `MemorySwap: 268435456`)
- **CPU Quota:** 0.5 CPU core (`NanoCPUs: 500000000`)
- **Network Isolation:** Fully disabled (`NetworkMode: 'none'`)
- **Process / Fork Bomb Limit:** 64 processes max (`PidsLimit: 64`)
- **Unprivileged User:** Executes as `USER sandbox` (UID 1000)
- **Safe Payload Delivery:** Direct argument passing (`Cmd: ['--code', code]`) over the Docker Remote API without shell interpolation
- **Ephemeral Teardown:** Immediate `container.remove({ force: true })` in the execution `finally` block ensuring zero lingering containers

---

## 3. Python 3.11 Dynamic Runner (`execution/runners/python/`)

The Python 3.11 runner executes dynamic user-submitted code in an unbuffered environment under an unprivileged `sandbox` user.

### Input Methods Supported
The runner searches for user code using the following prioritized hierarchy:
1. **CLI Flag `--code`**: `python runner.py --code "print('hello')"` (used by Dockerode orchestrator).
2. **CLI File Argument**: `python runner.py /path/to/script.py`.
3. **Environment Variable `SUBMISSION_FILE`**: `SUBMISSION_FILE=/path/to/script.py python runner.py`.
4. **Default Mount Path**: Looks for `/app/submission.py`, `/app/submission/code.py`, or `./submission.py`.
5. **Environment Variable `SUBMISSION_CODE`**: `SUBMISSION_CODE="print('hello')" python runner.py`.

### Stdin Data Support
When executing a submission file, standard input (`sys.stdin`) is passed directly through to the running user program.

### Output & Exit Codes
- **`stdout`**: Captured directly with unbuffered stream forwarding (`PYTHONUNBUFFERED=1` / `-u`).
- **`stderr`**: Unhandled exceptions, tracebacks, and syntax errors are output directly to `stderr`.
- **`exitCode`**: Propagates the exact process return code from user code (e.g. `sys.exit(0)` -> `0`, uncaught exception -> `1`, `sys.exit(42)` -> `42`).

### Building the Docker Image
```bash
docker build -t codecollab-runner-python:latest execution/runners/python
```

---

## 4. Other Language Runners (`execution/runners/`)

- `java/` — OpenJDK 17 runner *(placeholder skeleton; orchestration scheduled for future milestone)*.
- `cpp/` — GCC 13 runner *(placeholder skeleton; orchestration scheduled for future milestone)*.

---

## 5. Verification Status (M0.5b)

- **Dockerode Integration:** Verified working on host Docker daemon.
- **Python Runner:** Image built and tested with dynamic code inputs.
- **Integration Tests:** `testing/execution/execution.test.js` (13/13 passing).
- **Unit Tests:** `testing/execution/python_runner.test.js` (12/12 passing).
- **Full Test Suite:** 43/43 tests passing across backend, realtime, and execution modules.

---

## 6. Known Limitations (M0.5b)

- **C++ and Java Runners:** Remain static placeholders. Invoking non-Python languages in `executeCode` throws an unsupported language error.
- **Queue Persistence:** `queue.js` is an in-memory stub; Redis + BullMQ integration is planned for M0.5c.
- **Backend API & Socket:** Backend endpoint (`POST /api/execute`) and Socket.IO execution triggers are planned for M0.5d.
- **Frontend Terminal:** Terminal UI output rendering component is planned for M0.5e.

