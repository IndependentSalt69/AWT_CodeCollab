# Execution Engine & Runners

This directory houses the containerized code execution subsystem for CodeCollab.

## Engine (`execution/engine/`)
- `executeCode.js` — Main execution entry point.
- `executor.js` — Docker container lifecycle and stream management.
- `queue.js` — BullMQ/In-memory job queue for throttling code execution runs.
- `resultParser.js` — Output formatting and error parsing.
- `sandboxConfig.js` — Resource limits (CPU, memory, timeout, network disabled).

## Runners (`execution/runners/`)
- `python/` — Python 3.11 isolated container runner.
- `java/` — OpenJDK 17 isolated container runner.
- `cpp/` — GCC 13 isolated container runner.
