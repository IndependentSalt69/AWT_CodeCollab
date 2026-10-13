/**
 * CodeCollab M1.1 — Resource Enforcement Classifier
 *
 * Provides pure classification logic, verdict resolution, sanitization,
 * and report formatting for the Linux resource-enforcement evaluation harness.
 */

const VERDICT_PASS = 'PASS';
const VERDICT_FAIL = 'FAIL';
const VERDICT_BLOCKED = 'BLOCKED';
const VERDICT_UNSUPPORTED = 'UNSUPPORTED';
const VERDICT_SKIPPED = 'SKIPPED';

const STATUS_QUALIFIED = 'QUALIFIED_FOR_PRODUCTION';
const STATUS_NOT_QUALIFIED = 'NOT_QUALIFIED_FOR_PRODUCTION';

/**
 * Sanitizes an object, redacting passwords, tokens, and secret strings.
 *
 * @param {any} val
 * @returns {any}
 */
function sanitizeDetails(val) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'string') {
    return val
      .replace(/(:\/\/)([^:@\s]+)?(?::([^@\s]+))?@/g, '$1$2:***@')
      .replace(/(password|secret|token)=([^&\s]+)/gi, '$1=***');
  }
  if (Array.isArray(val)) {
    return val.map(sanitizeDetails);
  }
  if (typeof val === 'object') {
    const cleaned = {};
    for (const [k, v] of Object.entries(val)) {
      if (/password|secret|key|token/i.test(k) && typeof v === 'string') {
        cleaned[k] = '***';
      } else {
        cleaned[k] = sanitizeDetails(v);
      }
    }
    return cleaned;
  }
  return val;
}

/**
 * Classifies memory enforcement outcome.
 *
 * Qualification rule:
 * A memory probe passes ONLY when convincing cgroup/Docker OOM evidence tied to the container limit
 * is observed (State.OOMKilled === true or positive memory.events oom_kill delta).
 * Generic exit code 137 without attributable OOM evidence is classified as FAIL.
 * If a supervising shell survives child OOM, container exitCode 0 with genuine OOM evidence passes.
 *
 * @param {Object} evidence
 * @returns {Object} { status, exitCode, oomKilled, explanation, evidence }
 */
function classifyMemoryEnforcement(evidence = {}) {
  const {
    configuredLimitBytes = 128 * 1024 * 1024,
    exitCode = null,
    oomKilled = false,
    memoryEventsDelta = {},
    observedMemoryMax = null,
    stdout = '',
    stderr = '',
    timedOut = false,
    error = null,
  } = evidence;

  const oomKillCount = Number(memoryEventsDelta.oom_kill || 0);
  const oomEventCount = Number(memoryEventsDelta.oom || 0);

  if (error) {
    return {
      status: VERDICT_FAIL,
      exitCode,
      oomKilled: false,
      explanation: `Memory probe failed with error: ${error}`,
      evidence: sanitizeDetails(evidence),
    };
  }

  if (timedOut) {
    return {
      status: VERDICT_FAIL,
      exitCode,
      oomKilled: false,
      explanation: 'Memory probe timed out before kernel OOM could be verified.',
      evidence: sanitizeDetails(evidence),
    };
  }

  // Check if workload finished without OOM
  if (stdout.includes('ALLOCATION_FINISHED_WITHOUT_OOM')) {
    return {
      status: VERDICT_FAIL,
      exitCode,
      oomKilled: false,
      explanation: `Process allocated beyond the ${configuredLimitBytes / (1024 * 1024)} MiB limit without triggering kernel OOM. Enforcement is inactive.`,
      evidence: sanitizeDetails(evidence),
    };
  }

  // Check if cgroup metrics are inaccessible
  if (stdout.includes('CGROUP_MEMORY_EVENTS_BEFORE:ERR') || evidence.metricsUnavailable) {
    return {
      status: VERDICT_UNSUPPORTED,
      exitCode,
      oomKilled: false,
      explanation: 'Kernel cgroup memory.events metrics are inaccessible or unsupported in this container environment.',
      evidence: sanitizeDetails(evidence),
    };
  }

  // Positive OOM indicators:
  // 1. Docker inspect recorded State.OOMKilled === true
  // 2. memory.events delta shows oom_kill >= 1
  const hasOomKilledFlag = oomKilled === true;
  const hasOomKillEvents = oomKillCount > 0;

  if (hasOomKilledFlag || hasOomKillEvents) {
    let reason = 'Kernel OOM enforcement verified: ';
    const notes = [];
    if (hasOomKilledFlag) notes.push('Docker State.OOMKilled=true');
    if (hasOomKillEvents) notes.push(`memory.events oom_kill delta=${oomKillCount}`);
    if (exitCode === 137) notes.push('exitCode=137 (SIGKILL)');
    else if (exitCode === 0) notes.push('exitCode=0 (supervisor survived child OOM)');
    else if (exitCode !== null) notes.push(`exitCode=${exitCode}`);

    return {
      status: VERDICT_PASS,
      exitCode,
      oomKilled: true,
      explanation: reason + notes.join(', ') + '.',
      evidence: sanitizeDetails({
        ...evidence,
        oomKillCount,
        oomEventCount,
      }),
    };
  }

  // Generic exit code 137 without attributable OOM evidence is classified as FAIL
  if (exitCode === 137) {
    return {
      status: VERDICT_FAIL,
      exitCode,
      oomKilled: false,
      explanation: 'Container process terminated with exitCode 137 (SIGKILL), but neither Docker State.OOMKilled nor memory.events oom_kill delta recorded an OOM event. Unattributed termination cannot be certified as cgroup memory enforcement.',
      evidence: sanitizeDetails(evidence),
    };
  }

  return {
    status: VERDICT_FAIL,
    exitCode,
    oomKilled: false,
    explanation: `No kernel OOM indicators observed (exitCode: ${exitCode}, OOMKilled: ${oomKilled}, oom_kill delta: ${oomKillCount}).`,
    evidence: sanitizeDetails(evidence),
  };
}

/**
 * Classifies PID limit enforcement outcome.
 *
 * Strict requirements:
 * 1. fork loop was trapped with EAGAIN/BlockingIOError.
 * 2. Positive and plausible child count relative to limit. Zero or too few children fails.
 * 3. Positive delta in pids.events max counter corroborates kernel cgroup controller limit.
 *
 * @param {Object} evidence
 * @returns {Object} { status, forkBlocked, childrenSpawned, explanation, evidence }
 */
function classifyPidEnforcement(evidence = {}) {
  const {
    configuredPidsLimit = 10,
    observedPidsMax = null,
    childrenSpawned = 0,
    forkBlocked = false,
    pidsEventsDelta = {},
    childrenReaped = 0,
    exitCode = null,
    stdout = '',
    stderr = '',
    error = null,
  } = evidence;

  const pidsMaxHits = Number(pidsEventsDelta.max || 0);

  if (error) {
    return {
      status: VERDICT_FAIL,
      forkBlocked: false,
      childrenSpawned,
      explanation: `PID probe failed with error: ${error}`,
      evidence: sanitizeDetails(evidence),
    };
  }

  // Check if cgroup metrics are reported as inaccessible
  if (stdout.includes('CGROUP_PIDS_EVENTS_BEFORE:ERR') || evidence.metricsUnavailable) {
    return {
      status: VERDICT_UNSUPPORTED,
      forkBlocked: false,
      childrenSpawned,
      explanation: 'Kernel cgroup pids.events metrics are inaccessible or unsupported in this container environment.',
      evidence: sanitizeDetails(evidence),
    };
  }

  if (stdout.includes('FORK_NEVER_BLOCKED')) {
    return {
      status: VERDICT_FAIL,
      forkBlocked: false,
      childrenSpawned,
      explanation: `Fork loop spawned past the configured limit of ${configuredPidsLimit} without restriction. Kernel PID enforcement is inactive.`,
      evidence: sanitizeDetails(evidence),
    };
  }

  // Check if fork was trapped in loop
  const caughtInStdout = stdout.includes('FORK_BLOCKED_AT_') || /BlockingIOError|Resource temporarily unavailable|Errno 11/i.test(stdout);
  const isForkBlocked = forkBlocked || caughtInStdout;

  // Zero children: immediate failure, not PID limit enforcement
  if (childrenSpawned <= 0) {
    return {
      status: VERDICT_FAIL,
      forkBlocked: isForkBlocked,
      childrenSpawned: 0,
      explanation: `PID limit probe failed: zero children were created (spawned: 0, limit: ${configuredPidsLimit}). An immediate failure or crash cannot certify PID limit enforcement.`,
      evidence: sanitizeDetails(evidence),
    };
  }

  // Plausible children count: container has at least 1 existing process (supervisor/python PID 1).
  const minPlausible = Math.max(1, configuredPidsLimit - 4);
  const maxPlausible = configuredPidsLimit;
  if (childrenSpawned < minPlausible) {
    return {
      status: VERDICT_FAIL,
      forkBlocked: isForkBlocked,
      childrenSpawned,
      explanation: `Too few children spawned (${childrenSpawned}) for configured limit of ${configuredPidsLimit} (plausible range: ${minPlausible}–${maxPlausible}). Premature fork failure is not cgroup PID enforcement.`,
      evidence: sanitizeDetails(evidence),
    };
  }

  if (childrenSpawned > maxPlausible) {
    return {
      status: VERDICT_FAIL,
      forkBlocked: isForkBlocked,
      childrenSpawned,
      explanation: `Spawned ${childrenSpawned} children, exceeding the configured limit of ${configuredPidsLimit}. Kernel PID limit was not enforced.`,
      evidence: sanitizeDetails(evidence),
    };
  }

  // Require positive delta in pids.events max counter
  if (pidsMaxHits <= 0) {
    return {
      status: VERDICT_FAIL,
      forkBlocked: isForkBlocked,
      childrenSpawned,
      explanation: `pids.events max hit counter did not increment (delta: ${pidsMaxHits}). Fork failure was not corroborated by the kernel PID cgroup controller.`,
      evidence: sanitizeDetails(evidence),
    };
  }

  // Check observed pids.max if available
  if (observedPidsMax !== null && observedPidsMax !== undefined && observedPidsMax !== 'max') {
    const parsedObserved = parseInt(observedPidsMax, 10);
    if (!isNaN(parsedObserved) && parsedObserved !== configuredPidsLimit) {
      return {
        status: VERDICT_FAIL,
        forkBlocked: isForkBlocked,
        childrenSpawned,
        explanation: `Observed pids.max (${parsedObserved}) does not match configured limit (${configuredPidsLimit}).`,
        evidence: sanitizeDetails(evidence),
      };
    }
  }

  if (isForkBlocked) {
    return {
      status: VERDICT_PASS,
      forkBlocked: true,
      childrenSpawned,
      explanation: `PID limit enforced at ${childrenSpawned} child processes (limit: ${configuredPidsLimit}). fork() blocked with EAGAIN/BlockingIOError and corroborated by pids.events max delta=${pidsMaxHits}. Reaped ${childrenReaped} children cleanly.`,
      evidence: sanitizeDetails({
        ...evidence,
        pidsMaxHits,
      }),
    };
  }

  return {
    status: VERDICT_FAIL,
    forkBlocked: false,
    childrenSpawned,
    explanation: `PID limit not demonstrated as expected (forkBlocked: ${isForkBlocked}, spawned: ${childrenSpawned}, limit: ${configuredPidsLimit}).`,
    evidence: sanitizeDetails(evidence),
  };
}

/**
 * Classifies CPU quota / CFS bandwidth throttling outcome.
 *
 * Strict requirement:
 * CFS bandwidth throttling evidence (cpu.stat nr_throttled > 0 or throttled_usec > 0)
 * MUST be observed. A timing ratio alone cannot certify CPU enforcement without kernel throttling evidence.
 *
 * @param {Object} evidence
 * @returns {Object} { status, requestedNanoCPUs, cpuRatio, explanation, evidence }
 */
function classifyCpuEnforcement(evidence = {}) {
  const {
    requestedNanoCPUs = 500000000,
    wallSeconds = 0,
    processCpuSeconds = 0,
    cpuStatDelta = {},
    observedCpuMax = null,
    exitCode = null,
    stdout = '',
    stderr = '',
    error = null,
  } = evidence;

  if (error) {
    return {
      status: VERDICT_FAIL,
      requestedNanoCPUs,
      cpuRatio: 0,
      explanation: `CPU probe failed with error: ${error}`,
      evidence: sanitizeDetails(evidence),
    };
  }

  // If cgroup cpu.stat metrics were inaccessible
  if (stdout.includes('CGROUP_CPU_STAT_BEFORE:ERR') || evidence.metricsUnavailable) {
    return {
      status: VERDICT_UNSUPPORTED,
      requestedNanoCPUs,
      cpuRatio: 0,
      explanation: 'Kernel cgroup cpu.stat metrics are inaccessible or unsupported in this container environment.',
      evidence: sanitizeDetails(evidence),
    };
  }

  const targetRatio = requestedNanoCPUs / 1e9; // 0.5 for 500M NanoCPUs
  const actualRatio = wallSeconds > 0 ? (processCpuSeconds / wallSeconds) : 0;
  const matchRatio = stdout.match(/CPU_RATIO:([\d.]+)/);
  const parsedRatio = matchRatio ? parseFloat(matchRatio[1]) : actualRatio;

  const nrThrottled = Number(cpuStatDelta.nr_throttled || 0);
  const throttledUsec = Number(cpuStatDelta.throttled_usec || 0);
  const hasCfsThrottleStats = nrThrottled > 0 || throttledUsec > 0;

  // Strict requirement: CFS throttle stats MUST be present and > 0
  if (!hasCfsThrottleStats) {
    const unthrottledNote = parsedRatio >= 0.85 ? 'Workload executed unthrottled. ' : '';
    return {
      status: VERDICT_FAIL,
      requestedNanoCPUs,
      cpuRatio: parsedRatio,
      explanation: `${unthrottledNote}CFS bandwidth limit was not enforced: cpu.stat reported zero throttled periods (nr_throttled: ${nrThrottled}, throttled_usec: ${throttledUsec}). Observed CPU time ratio was ${parsedRatio.toFixed(3)}. Timing ratio alone cannot certify CPU enforcement without kernel throttling evidence.`,
      evidence: sanitizeDetails(evidence),
    };
  }

  return {
    status: VERDICT_PASS,
    requestedNanoCPUs,
    cpuRatio: parsedRatio,
    explanation: `CPU quota enforced: kernel CFS throttling verified (cpu.stat throttled periods=${nrThrottled}, throttled_usec=${throttledUsec}; observed CPU time ratio ${parsedRatio.toFixed(3)} against target ~${targetRatio.toFixed(2)}).`,
    evidence: sanitizeDetails({
      ...evidence,
      nrThrottled,
      throttledUsec,
    }),
  };
}

/**
 * Classifies gVisor (runsc) OCI integration.
 *
 * @param {Object} evidence
 * @returns {Object} { status, sandboxVerified, explanation, evidence }
 */
function classifyGvisorIntegration(evidence = {}) {
  const {
    runtimeRequested = 'runsc',
    runtimeRegistered = false,
    containerStarted = false,
    procVersion = '',
    startupError = null,
    stdout = '',
    stderr = '',
  } = evidence;

  // Case 1: Runtime not registered on daemon
  if (!runtimeRegistered) {
    return {
      status: VERDICT_BLOCKED,
      sandboxVerified: false,
      explanation: "Requested runtime 'runsc' (gVisor) is not registered in Docker daemon (daemon.json).",
      evidence: sanitizeDetails(evidence),
    };
  }

  // Case 2: Known WSL2 systemd/polkit D-Bus startup blocker
  if (startupError) {
    const errorStr = String(startupError);
    if (/interactive authentication required/i.test(errorStr) || /polkit/i.test(errorStr)) {
      return {
        status: VERDICT_BLOCKED,
        sandboxVerified: false,
        explanation: `gVisor runtime startup blocked by host environment: "${errorStr}". This is a known WSL2/systemd polkit user-session authentication limitation.`,
        evidence: sanitizeDetails(evidence),
      };
    }

    return {
      status: VERDICT_FAIL,
      sandboxVerified: false,
      explanation: `gVisor container startup failed: ${errorStr}`,
      evidence: sanitizeDetails(evidence),
    };
  }

  // Case 3: Container executed — inspect /proc/version for gVisor identity
  const combinedOutput = `${procVersion} ${stdout}`;
  if (/gVisor/i.test(combinedOutput)) {
    return {
      status: VERDICT_PASS,
      sandboxVerified: true,
      explanation: `gVisor sandbox identity confirmed from inside container: /proc/version contains 'gVisor' (${procVersion.trim()}).`,
      evidence: sanitizeDetails(evidence),
    };
  }

  // Case 4: Container started, but did NOT identify as gVisor (ran on host kernel)
  return {
    status: VERDICT_FAIL,
    sandboxVerified: false,
    explanation: `Container ran, but /proc/version does not identify gVisor. Detected host kernel: "${procVersion.trim()}". Possible silent downgrade or misconfiguration.`,
    evidence: sanitizeDetails(evidence),
  };
}

/**
 * Resolves the overall qualification verdict based on environment and results.
 *
 * Explicit qualification rules:
 * A dedicated Linux production deployment is qualified ONLY when:
 * 1. Platform is native Linux (not Windows, not WSL2).
 * 2. Connected Docker daemon is explicitly rootless (isRootless === true).
 * 3. Cgroup v2 controllers are enforced under systemd (daemon.cgroupControllersEnforced === true).
 * 4. Memory, PID, CPU, and gVisor checks all evaluate to PASS.
 * 5. Daemon connection is active and validated (daemon.connected === true).
 * 6. Environment metadata does not contradict daemon capability evidence.
 *
 * @param {Object} environment
 * @param {Object} [daemonOrResults] - Docker daemon probe result, or testResults if 2 args
 * @param {Object} [maybeResults] - Test results if 3 args passed
 * @returns {string} STATUS_QUALIFIED or STATUS_NOT_QUALIFIED
 */
function resolveOverallVerdict(environment = {}, daemonOrResults = {}, maybeResults) {
  let daemon = {};
  let testResults = {};
  let hasExplicitDaemon = false;

  if (maybeResults !== undefined) {
    hasExplicitDaemon = true;
    daemon = daemonOrResults || {};
    testResults = maybeResults || {};
  } else {
    daemon = environment || {};
    testResults = daemonOrResults || {};
  }

  const isWindows = environment.platform === 'win32';
  const isWsl = Boolean(environment.isWsl);
  const isLinux = environment.platform === 'linux';

  // Windows and WSL2 can NEVER qualify a dedicated Linux production release
  if (isWindows || isWsl || !isLinux) {
    return STATUS_NOT_QUALIFIED;
  }

  // Reject contradictory values if environment duplicates daemon capability fields.
  // Environment metadata must NEVER override missing, false, or contradictory daemon evidence.
  if (hasExplicitDaemon) {
    if (environment.connected !== undefined && environment.connected !== daemon.connected) {
      return STATUS_NOT_QUALIFIED;
    }
    if (environment.isRootless !== undefined && environment.isRootless !== daemon.isRootless) {
      return STATUS_NOT_QUALIFIED;
    }
    if (
      environment.cgroupControllersEnforced !== undefined &&
      environment.cgroupControllersEnforced !== daemon.cgroupControllersEnforced
    ) {
      return STATUS_NOT_QUALIFIED;
    }
  }

  // Production qualification strictly requires genuine daemon capability evidence:
  // connected === true, isRootless === true, and cgroupControllersEnforced === true.
  if (daemon.connected !== true || daemon.isRootless !== true || daemon.cgroupControllersEnforced !== true) {
    return STATUS_NOT_QUALIFIED;
  }

  // Reject if environment explicitly marks daemon connection as false
  if (environment.connected === false) {
    return STATUS_NOT_QUALIFIED;
  }

  const memoryPass = testResults.memory?.status === VERDICT_PASS;
  const pidPass = testResults.pid?.status === VERDICT_PASS;
  const cpuPass = testResults.cpu?.status === VERDICT_PASS;
  const gvisorPass = testResults.gvisor?.status === VERDICT_PASS;

  if (memoryPass && pidPass && cpuPass && gvisorPass) {
    return STATUS_QUALIFIED;
  }

  return STATUS_NOT_QUALIFIED;
}

/**
 * Generates a human-readable Markdown summary of the evaluation run.
 *
 * @param {Object} report
 * @returns {string}
 */
function generateSummaryMarkdown(report) {
  const env = report.environment || {};
  const res = report.results || {};
  const verdict = report.verdict || STATUS_NOT_QUALIFIED;

  const wslNotice = env.isWsl
    ? '> [!WARNING]\n> **WSL2 Environment Detected:** Observed evidence provides preliminary proof of cgroup v2 mechanics, but WSL2 does not qualify a dedicated Linux production deployment due to virtualization, dynamic RAM sharing, and polkit differences.\n\n'
    : '';

  const winNotice = env.platform === 'win32'
    ? '> [!NOTE]\n> **Windows Host Detected:** Windows cannot run live Linux cgroup v2 kernel stress probes. Normal Windows development remains intact; live qualification is reserved for Linux.\n\n'
    : '';

  return `# CodeCollab M1.1 — Resource Enforcement Evaluation Summary

**Run ID:** \`${report.runId || 'unknown'}\`  
**Timestamp:** ${report.timestamp || new Date().toISOString()}  
**Verdict:** **\`${verdict}\`**  

${winNotice}${wslNotice}## 1. Environment & Preflight Details

| Attribute | Observed Value |
| :--- | :--- |
| **OS / Platform** | \`${env.platform} (${env.arch})\` |
| **Distribution** | \`${env.distribution || 'N/A'}\` |
| **Kernel Release** | \`${env.kernelRelease || 'N/A'}\` |
| **WSL2 Detected** | \`${Boolean(env.isWsl)}\` |
| **Docker Server Version** | \`${env.dockerVersion || 'N/A'}\` |
| **Cgroup Driver / Version** | \`${env.cgroupDriver || 'none'} / v${env.cgroupVersion || 'unknown'}\` |
| **Rootless Daemon** | \`${Boolean(env.isRootless)}\` |
| **Cgroup Controllers Enforced** | \`${Boolean(env.cgroupControllersEnforced)}\` |
| **gVisor (runsc) Registered** | \`${Boolean(env.hasRunsc)}\` |

---

## 2. Resource Enforcement Checks

| Check | Status | Key Observations & Explanation |
| :--- | :---: | :--- |
| **Memory Limit & OOM** | **\`${res.memory?.status || VERDICT_SKIPPED}\`** | ${res.memory?.explanation || 'Not executed'} |
| **PID Limit (Fork Bomb)** | **\`${res.pid?.status || VERDICT_SKIPPED}\`** | ${res.pid?.explanation || 'Not executed'} |
| **CPU Quota (CFS Bandwidth)** | **\`${res.cpu?.status || VERDICT_SKIPPED}\`** | ${res.cpu?.explanation || 'Not executed'} |
| **gVisor (runsc) Sandbox** | **\`${res.gvisor?.status || VERDICT_SKIPPED}\`** | ${res.gvisor?.explanation || 'Not executed'} |

---

## 3. Production Qualification Determination

- **Final Determination:** \`${verdict}\`
- **Qualification Criteria:** Every required control (Memory OOM kill, PID fork block, CPU quota throttling, and gVisor sandbox identity) must genuinely pass on an unprivileged, rootless Linux host managed by systemd cgroup v2 delegation.
`;
}

module.exports = {
  VERDICT_PASS,
  VERDICT_FAIL,
  VERDICT_BLOCKED,
  VERDICT_UNSUPPORTED,
  VERDICT_SKIPPED,
  STATUS_QUALIFIED,
  STATUS_NOT_QUALIFIED,
  classifyMemoryEnforcement,
  classifyPidEnforcement,
  classifyCpuEnforcement,
  classifyGvisorIntegration,
  resolveOverallVerdict,
  generateSummaryMarkdown,
  sanitizeDetails,
};
