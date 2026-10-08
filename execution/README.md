# Execution Engine & Runners

This directory houses the containerized code execution subsystem for CodeCollab.

## Architecture

```text
Code Submission
      ↓
Execution Engine (executeCode.js)
      ↓
Queue (queue.js)
      ↓
Sandbox Executor (executor.js)
      ↓
Docker Container (codecollab-runner-python / java / cpp)
      ↓
Language Runner Script (e.g. runner.py)
      ↓
stdout / stderr / exit code
      ↓
Result Parser (resultParser.js)
```

---

## 1. Engine (`execution/engine/`)

- `executeCode.js` — Main execution entry point. Validates language/code and coordinates sandboxed execution.
- `executor.js` — Container lifecycle and stream management interface (mock in M0.5a, Dockerode orchestrator in M0.5b).
- `queue.js` — Asynchronous job queue for throttling execution runs.
- `resultParser.js` — Normalizes stdout, stderr, execution time, and process exit code into a structured result object.
- `sandboxConfig.js` — Default resource configuration (CPU: 0.5, Memory: 256MB, Timeout: 5000ms, Network: disabled).

---

## 2. Python 3.11 Dynamic Runner (`execution/runners/python/`)

The Python 3.11 runner executes dynamic user-submitted code in an unbuffered environment under an unprivileged `sandbox` user.

### Input Methods Supported
The runner searches for user code using the following prioritized hierarchy:
1. **CLI Flag `--code`**: `python runner.py --code "print('hello')"` (writes and executes temporary script).
2. **CLI File Argument**: `python runner.py /path/to/script.py`.
3. **Environment Variable `SUBMISSION_FILE`**: `SUBMISSION_FILE=/path/to/script.py python runner.py`.
4. **Default Mount Path**: Looks for `/app/submission.py`, `/app/submission/code.py`, or `./submission.py`.
5. **Environment Variable `SUBMISSION_CODE`**: `SUBMISSION_CODE="print('hello')" python runner.py`.

### Stdin Data Support
When executing a submission file, standard input (`sys.stdin`) is passed directly through to the running user program. User code calling `input()` or `sys.stdin.read()` consumes incoming stdin data seamlessly.

### Output & Exit Codes
- **`stdout`**: Captured directly with unbuffered stream forwarding (`PYTHONUNBUFFERED=1` / `-u`).
- **`stderr`**: Unhandled exceptions, tracebacks, and syntax errors are output directly to `stderr`.
- **`exitCode`**: Propagates the exact process return code from user code (e.g. `sys.exit(0)` -> `0`, uncaught exception -> `1`, `sys.exit(42)` -> `42`).

### Building the Docker Image
```bash
docker build -t codecollab-runner-python:3.11 execution/runners/python
```

### Running a Sample Submission
Mounting a user code file at `/app/submission.py`:
```bash
docker run --rm -v "$(pwd)/my_script.py:/app/submission.py:ro" codecollab-runner-python:3.11
```

Passing code via environment variable:
```bash
docker run --rm -e SUBMISSION_CODE="print(1 + 2)" codecollab-runner-python:3.11
```

Piping stdin data to user script:
```bash
echo "Alice" | docker run --rm -i -e SUBMISSION_CODE="print(f'Hello {input()}')" codecollab-runner-python:3.11
```

---

## 3. Other Language Runners (`execution/runners/`)

- `java/` — OpenJDK 17 runner *(placeholder skeleton in M0.5a)*.
- `cpp/` — GCC 13 runner *(placeholder skeleton in M0.5a)*.

---

## 4. Current Limitations & Security Notes (M0.5a)

### Current Limitations:
- **C++ and Java Runners:** Remain static placeholders until upcoming milestones.
- **Dockerode Orchestrator:** The Node.js executor (`executor.js`) is still a mock interface; dynamic container spawning from backend is targeted for M0.5b.
- **Queue Persistence:** `queue.js` is an in-memory stub; Redis + BullMQ integration is deferred.

### Security Limitations:
- **Docker Isolation Unenforced by Host:** While the Dockerfile runs as non-root `USER sandbox`, daemon-level flags (`--network none`, `--cpus`, `--memory 256m`, `--pids-limit 64`, `--read-only`) must be enforced during container instantiation by the Dockerode orchestrator in M0.5b.
- **Execution Timeouts:** Hard timeout killing (SIGTERM / SIGKILL) is not yet managed at the container runtime level.
