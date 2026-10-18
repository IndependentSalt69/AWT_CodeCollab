# Execution security, C++, and Java implementation report

Date: 2026-10-18 (Asia/Calcutta).

## A. Git and branch status

- Starting branch: `main`; initial index and working tree were clean, with no untracked user files.
- Remote fetch completed successfully. Latest appropriate `origin/main` and starting commit: `2e522446cc3c9a3916e64bc01ee95766b9f8bf04` (`Merge pull request #7 from IndependentSalt69/feature/infrastructure-mongodb-uri-override`).
- Created `feature/execution-security-cpp-java` from that commit. HEAD remains at the starting commit; all implementation is unstaged and uncommitted.
- No staging, commits, push, PR, merge, history rewriting, branch deletion, or changes to main. The branch currently tracks `origin/main` because it was created from that ref.
- GitHub CLI was unavailable; remote refs and commit history were inspected, but authenticated issues/PR inspection was not performed.
- Exact changed/new/deleted paths are listed in [the review manifest](execution-security-cpp-java-files.txt). Deleted files are the unused placeholder `cpp/run.sh` and `java/runner.java`.
- Generated logs/reports are ignored under `eval/reports/`; frontend build output remains ignored. Runner images are available in Docker Desktop and the nested daemon. Temporary test Redis and transfer archives are removed after verification; existing application services/data are preserved.

## B. Implemented work

### P0: qualification correctness

The existing harness already checked rootless/systemd/cgroup-v2 eligibility and had memory, PID, CPU and gVisor probes. This change corrects additional false-positive cases:

- Memory OOM evidence must include an exact finite `memory.max` matching the configured limit.
- PID evidence requires the exact finite `pids.max`, successful completion, and verified reaping of all spawned children via confirmed waitpid return values without ignoring wait/kill failures. Missing or partial reap output fails closed. The bounded production PID probe now attempts 79 forks against limit 64, instead of only 25.
- CPU evidence requires matching finite `cpu.max`, a successful workload, positive throttling counters, and measured CPU usage consistent with the quota.
- gVisor evidence requires successful start/exit, no timeout, explicit runsc and identity in `/proc/version` itself.
- Resource probes explicitly request `runsc`, rather than combining daemon-default resource tests with a separate gVisor smoke result.
- Failed container removal remains tracked and prevents qualification; executor cleanup errors are reported instead of silently returning success.
- An explicit `requireCgroups:false` option can no longer bypass production policy.
- Worker logs distinguish advertised capabilities from proven enforcement. Overall qualification requires timeout/output/cleanup/authorization/room-isolation evidence, including any requested production PID check. Missing checks remain blocked. The resource-only CLI does not generate application-path evidence and cannot independently qualify a release.

No sandbox limits or assertions were weakened. Native host permissions, real environment files, database contents and daemon configuration were not modified.

### P1: compiled runners

Previously C++ and Java were placeholders, rejected by the API and worker and disabled in the UI. They now share the existing execution architecture:

- `languages.js` supplies the API and executor image allowlist, including protection against prototype-property language identifiers.
- `compiled_runner.py` writes fixed source paths in a disposable `/work` tmpfs, invokes compiler/program with argument arrays and no shell, and terminates each process group. Container removal handles the final process/filesystem boundary, including timeout or detached descendants.
- C++: GCC 13, `-std=c++17`, fixed `main.cpp` and output binary. Only its bounded `/work` mount permits binary execution; `/tmp` remains noexec.
- Java: Temurin JDK 17, fixed `Main.java`, default-package `Main.main(String[])`. Other public names/packages/missing main fail deterministically through diagnostics. No user-supplied filenames, classpaths, compiler flags or JVM options. Heap 96 MiB, stack 256 KiB, metaspace 64 MiB, code cache 32 MiB, SerialGC, one active processor; kernel limits remain authoritative.
- Both compile and run as UID 1000 with the existing read-only rootfs, no networking, dropped capabilities, no-new-privileges, 256 MiB ceiling, 0.5 CPU and 64 PIDs. The 5-second default / 10-second maximum is a **combined compilation-and-execution deadline**. Output remains capped at 64 KiB per stream and source at 64 KiB.
- API rejects empty, whitespace-only, NUL and oversized source. Compiler diagnostics/runtime failures use the established stderr/exitCode/status fields.
- `start.ps1` builds, saves, copies, loads and checks Python/C++/Java images in the inner daemon before starting the worker. Shared runner build context is documented in `execution/README.md`.
- Minimal UI changes enable Java/C++ and update language labels/tooltips. Python, terminal results, driver authorization and room events retain their existing paths.

Tests now cover successful execution, compiler error, runtime failure, compile/run timeouts, excessive output, invalid/empty/oversized code, unsupported languages, unauthorized execution, missing-image errors (mock daemon), and removal after success/failure/timeout/descendant creation. Backend execution tests use the standalone worker module and real Redis/Docker, with mocked database writes.

## C. Verification

Status vocabulary: `PASS` = executed/passed; `FAIL` = executed/failed; `BLOCKED` = environmental or external prerequisite; `NOT RUN` = not attempted.

Host test configuration was process-local and did not edit `.env`:

```powershell
$env:REDIS_URL='redis://127.0.0.1:16379/0'
$env:MONGO_URI='mongodb://127.0.0.1:27099/codecollab_mission_test'
$env:JWT_SECRET='mission-test-only-jwt-not-a-real-secret'
$env:DOCKER_HOST='npipe:////./pipe/docker_engine'
```

The Redis endpoint belonged to a temporary `redis:7-alpine` container with disposable anonymous storage and a loopback-only published port. It was separate from application Redis. The container and its anonymous storage were removed after verification. Database-dependent API tests mocked model writes; no real MongoDB connection was made.

| Check | Status | Actual command/test | Result/evidence |
|---|---|---|---|
| Initial focused baseline | PASS | `npm.cmd test -- --runTestsByPath testing/security/resource_enforcement_harness.test.js testing/security/rootless_daemon_runtime.test.js testing/execution/python_runner.test.js testing/frontend/execution_frontend.test.js testing/frontend/react_components.test.jsx` | Exit 0; 5 suites, 153 tests. Initial sandbox attempt failed before any tests due to Jest cache rename EPERM; rerun outside sandbox passed. |
| Baseline build | PASS | `npm.cmd run build` | Exit 0. |
| C++ image | PASS | `docker build -t codecollab-runner-cpp:latest -f execution/runners/cpp/Dockerfile execution/runners` | Exit 0. |
| Java image | PASS | `docker build -t codecollab-runner-java:latest -f execution/runners/java/Dockerfile execution/runners` | Exit 0. |
| Final broad functional/security regression | PASS | `npm.cmd test -- --testPathIgnorePatterns testing/integration --json --outputFile=eval/reports/mission-final-tests.json` | Exit 0; **25 suites, 432 tests**. Includes backend, execution, security, realtime and frontend tests. Log emitted a delayed-exit/open-handle warning; process subsequently exited successfully without force-exit. |
| Final qualification/reporting regression | PASS | `npm.cmd test -- --runTestsByPath testing/security/resource_enforcement_harness.test.js testing/security/qualification_regressions.test.js` | Exit 0; 2 suites, 114 tests after the child process reaping correctness fix and complete/partial/missing/invalid reaping regression coverage. |
| Final frontend build | PASS | `npm.cmd run build` | Exit 0; tsc and Vite succeeded. Existing Vite native-config compatibility warning remains. Backend has no separate compile/build script. |
| Python smoke/regression | PASS | `testing/execution/execution.test.js`, `python_runner.test.js` within final suite | Docker execution printed `Hello from CodeCollab!` and `5`; existing Python tests passed. |
| C++/Java smoke and negative cases on Docker Desktop | PASS | `testing/execution/compiled_runners.test.js` within final suite | 27 live tests, including `Hello from C++!` and `Hello from Java!`, exit 0 and empty stderr; failures/timeouts/output and cleanup verified. |
| Missing images and policy regression | PASS | `testing/security/qualification_regressions.test.js` | Mock Docker API failures and sandbox options; these are not live security qualification. |
| Inner image transfer | PASS | `docker image save --output eval/reports/mission-runners.tar codecollab-runner-cpp:latest codecollab-runner-java:latest`; `docker cp ... infrastructure-execution-daemon-1:/tmp/mission-runners-20261018.tar`; `docker exec ... docker -H tcp://127.0.0.1:2375 load -i ...` | Exit 0; all three runner tags confirmed inside the actual execution daemon. |
| Inner API/queue/worker | PASS | Linux test client: Jest `testing/backend/execute.test.js testing/execution/worker.test.js` | Both suites passed through `tcp://execution-daemon:2375`, separate test Redis DB 1, model writes mocked. C++ and Java API smoke, authorization, result/event propagation passed. |
| Full inner runner negative/repeat tests | FAIL | Same client: `testing/execution/compiled_runners.test.js`; repeated alone | First combined run: 51 passed / 2 failed out of 53. Retry: 10 passed / 17 failed out of 27. Failures are prestart/runtime startup errors, chiefly `pthread_create failed: Resource temporarily unavailable`. Current default nested stack is not fully functionally validated. |
| Compose validation | PASS | `docker compose --env-file infrastructure/.env.example -f infrastructure/docker-compose.yml --profile local-dev-execution config --quiet` | Exit 0 using process-local dummy values; no resolved secret-bearing config printed. |
| PowerShell startup syntax | PASS | PowerShell `Parser::ParseFile` on `start.ps1` | No parse errors. Whole script not run because it starts/rebuilds the existing application/database stack; equivalent build/load steps were exercised separately. |
| Windows strict harness | BLOCKED | `npm.cmd run eval:enforcement -- --strict --prod-pid --report-dir eval/reports/mission-windows` | Exit 1, expected refusal: Windows/Docker Desktop is not a native Linux qualification target. |
| Inner Linux strict harness | BLOCKED | Linux client: `node eval/verify-enforcement.js --strict --prod-pid --no-save --json` | Exit 1. Docker 27.5.1, WSL2, rootless, cgroup driver `none`, no runsc. CPU/memory/PID stress probes refused; no per-runner enforcement claimed. |
| WSL2 gVisor workload | BLOCKED | `wsl -d Ubuntu-24.04 -- sh /mnt/d/AWT_CodeCollab/eval/reports/wsl-gvisor.sh` | Nonzero exit; exact diagnostic: `creating container: systemd error: Interactive authentication required`. Python workload never started. |
| Native Linux production target | BLOCKED | Intended target unavailable | No native Linux CPU/memory/PID/gVisor or application-path qualification result. |
| Live Mongo integration | NOT RUN | `npm run test:integration:mongo` | Out of scope for runner changes; no real databases were touched. |
| Git whitespace | PASS | `git diff --check` | Exit 0. Informational LF-to-CRLF warnings are not whitespace failures. |

Earlier broad run had 423 passed/1 failed because the old queue test expected C++ to be unsupported. It was corrected to unsupported Ruby; focused rerun passed 105 tests, and the final broad run passed all 432. Four initial focused failures after stricter qualification were obsolete positive fixtures lacking newly required evidence; fixtures now explicitly supply that evidence, and separate negative regressions reject its absence. Assertions were not weakened.

Local detailed evidence: `eval/reports/mission-final-tests.json`, `mission-final-tests.log`, `mission-tests.json` (earlier run), `mission-retest.json`, `mission-inner-tests.log`, `mission-inner-retry.log`, `mission-inner-enforcement.json`, and `mission-windows/`. These logs are ignored and are not in the staging manifest.

The inner test client command was:

```powershell
docker run --rm --name codecollab-mission-inner-tests-20261018 --network infrastructure_execution-network --read-only --tmpfs /tmp:rw,nosuid,nodev,size=128m --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --mount type=bind,source=D:\AWT_CodeCollab,target=/workspace,readonly -w /workspace -e NODE_ENV=test -e REDIS_URL=redis://codecollab-mission-redis-20261018:6379/1 -e MONGO_URI=mongodb://127.0.0.1:27099/mission_unused -e JWT_SECRET=mission-test-only-jwt-not-a-real-secret -e DOCKER_HOST=tcp://execution-daemon:2375 node:20-alpine node node_modules/jest/bin/jest.js --runInBand --no-cache --runTestsByPath testing/execution/compiled_runners.test.js testing/backend/execute.test.js testing/execution/worker.test.js
```

This command requires recreating the disposable test Redis and connecting it to the internal execution network; it does not target the existing application Redis. The runner-only retry used the same client flags and only `testing/execution/compiled_runners.test.js`.

## D. Production execution-security status

**`NOT_QUALIFIED_FOR_PRODUCTION`**

The native Linux target was unavailable. Docker Desktop functional success is not production evidence. The nested daemon advertises no cgroup enforcement; Ubuntu WSL2 runsc startup fails OS authorization. Mandatory same-target per-runner resource controls, gVisor workload execution and full application security checks have not passed. Public untrusted execution must remain blocked.

## E. Unresolved blockers and diagnosis

1. **Native target absent.** Confirmed available hosts are Windows/Docker Desktop and WSL2, not the intended native Linux deployment. This blocks production qualification, not Docker Desktop runner functionality. Next prerequisite: access to the intended native Linux host with a dedicated rootless systemd daemon and delegated cgroup v2 CPU/memory/PID controllers.
2. **Inner daemon has no cgroup enforcement/runsc.** `docker exec infrastructure-execution-daemon-1 docker -H tcp://127.0.0.1:2375 info` reported driver `none`, v2, rootless and only runc/containerd runtimes. The strict Linux-client harness refused stress probes. Outer limits are not per-runner enforcement. Use the dedicated native daemon for production; do not enable an unenforced production exception.
3. **Repeated nested startup exhausts the outer PID budget.** First inner run passed API/worker and most runner cases; two JVM-entry tests failed before execution. A serial runner-only retry failed 17 startup-dependent cases. Diagnostics recorded `pids.current=116`, `pids.max=128`, `pids.events max=750`, while the inner daemon listed no remaining containers. This confirms outer PID limit hits; retained daemon/helper thread pressure is the likely mechanism, not a demonstrated per-runner leak. Limits were not raised or removed and the shared daemon was not restarted. Next action: operator maintenance of this local development daemon and evaluation of daemon/helper thread budgeting within its existing safety boundary; use native rootless execution for the production milestone. Blocks reliable repeated execution in the present nested stack as well as security qualification.
4. **WSL2 runsc authorization.** After the Ubuntu rootless daemon became responsive, it reported systemd/cgroup v2 and `/usr/local/bin/runsc`. A bounded, non-root, read-only, network-disabled Python container with the same resource restrictions failed with `Interactive authentication required`. No OS authorization or service configuration was bypassed. Next action: an operator must resolve the dedicated user's systemd/polkit session and runtime setup on the intended host and rerun the workload. WSL2 success alone still would not qualify native Linux.
5. **Full qualification evidence remains incomplete.** The hardened resource-only harness now records missing application-path checks as blocked rather than equating four resource checks with release qualification. A native-target release audit must also run authentication/room isolation, all language tests, output/timeout/cleanup checks on that exact daemon and retain the evidence. Do not manually set missing checks to PASS.

## F. Manual actions required

- Review the unstaged changes and decide what to stage/commit/push/submit. No agent Git publication work was performed.
- Provide/operate the intended native Linux rootless/gVisor host and resolve OS-level authorization. Verify the actual configured user socket; do not expose unauthenticated Docker TCP publicly or mount the privileged host socket.
- Rebuild/load all three images into that daemon. From a Linux shell using the dedicated user socket:

```sh
export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
export NODE_ENV=production CONTAINER_RUNTIME=runsc REQUIRE_CGROUP_ENFORCEMENT=true
unset ALLOW_UNENFORCED_CGROUPS
docker info --format 'Driver={{.CgroupDriver}} Version={{.CgroupVersion}}'
cat /sys/fs/cgroup/cgroup.controllers
systemctl --user status docker --no-pager
docker build -t codecollab-runner-python:latest execution/runners/python
docker build -t codecollab-runner-cpp:latest -f execution/runners/cpp/Dockerfile execution/runners
docker build -t codecollab-runner-java:latest -f execution/runners/java/Dockerfile execution/runners
npm run eval:enforcement -- --strict --prod-pid
```

Use a separate disposable Redis for test execution, then run the execution, backend/execute and security suites against this same daemon with `NODE_ENV=test`, `CONTAINER_RUNTIME=runsc`, `REQUIRE_CGROUP_ENFORCEMENT=true`. The resource-only harness will remain unqualified until the complete application evidence is accounted for; a clean resource result is necessary but insufficient.

## G. Recommendation and review commands

The branch is ready for code review of the runner implementation and qualification corrections. Functional Docker Desktop verification is complete. The current nested stack remains unreliable under repeated execution and production release is blocked. The next milestone is native Linux/gVisor qualification with all languages and the full application path.

Review the shared launcher, both Dockerfiles, executor/language validation, harness/classifiers, startup image transfer, minimal UI change and their regression tests. The [manifest](execution-security-cpp-java-files.txt) lists every intended path, including placeholder deletions and this report.

Run these yourself from the repository root; the agent stops before staging:

```powershell
git branch --show-current
git log -1 --oneline
git status --short --branch
git diff --check
git diff --stat
git diff
git diff --cached
git ls-files --others --exclude-standard
Get-Content docs/execution-security-cpp-java-files.txt
# Only after your review, stage exactly the intended paths:
git add --pathspec-from-file=docs/execution-security-cpp-java-files.txt
git diff --cached --check
git diff --cached --stat
```
