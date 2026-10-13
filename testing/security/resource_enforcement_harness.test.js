const {
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
} = require('../../eval/enforcement-classifier');

const {
  detectHostEnvironment,
  probeDockerDaemon,
  evaluatePreflight,
} = require('../../eval/environment-probe');

const {
  EnforcementTracker,
  executeProbeContainer,
  buildMemoryProbeScript,
  buildPidProbeScript,
  buildCpuProbeScript,
  buildGvisorProbeScript,
  probeMemoryEnforcement,
  probePidEnforcement,
  probeCpuEnforcement,
  probeGvisorIntegration,
} = require('../../eval/resource-probes');
const { runHarness } = require('../../eval/verify-enforcement');

describe('Resource Enforcement Evaluation Harness Unit Suite (M1.1 Phase 3)', () => {
  // --------------------------------------------------------------------------
  // 1. Memory Enforcement Classifier
  // --------------------------------------------------------------------------
  describe('1. Memory Enforcement Classifier', () => {
    test('classifies standard kernel OOM with exitCode 137 as PASS', () => {
      const result = classifyMemoryEnforcement({
        configuredLimitBytes: 128 * 1024 * 1024,
        exitCode: 137,
        oomKilled: true,
        memoryEventsDelta: { oom: 1, oom_kill: 1 },
        stdout: 'MEM_PROBE_START\nALLOCATED_16MB\nALLOCATED_32MB\nALLOCATED_48MB\n',
      });

      expect(result.status).toBe(VERDICT_PASS);
      expect(result.oomKilled).toBe(true);
      expect(result.exitCode).toBe(137);
      expect(result.explanation).toContain('Kernel OOM enforcement verified');
      expect(result.explanation).toContain('Docker State.OOMKilled=true');
    });

    test('QUALIFICATION RULE: classifies OOM as PASS when OOMKilled=true and oom_kill delta > 0 even if container exitCode is 0', () => {
      // Observed scenario: Supervising process survives child OOM and returns exit code 0
      const result = classifyMemoryEnforcement({
        configuredLimitBytes: 128 * 1024 * 1024,
        exitCode: 0, // Honest container exit code
        oomKilled: true, // Docker recorded OOM
        memoryEventsDelta: { oom: 1, oom_kill: 1 }, // cgroup counter incremented
        stdout: 'MEM_PROBE_START\nALLOCATED_16MB\nALLOCATED_128MB\n',
      });

      expect(result.status).toBe(VERDICT_PASS);
      expect(result.oomKilled).toBe(true);
      expect(result.exitCode).toBe(0); // Honestly recorded as 0, not manufactured as 137
      expect(result.explanation).toContain('exitCode=0 (supervisor survived child OOM)');
    });

    test('classifies as FAIL when workload allocated past limit without triggering OOM', () => {
      const result = classifyMemoryEnforcement({
        configuredLimitBytes: 128 * 1024 * 1024,
        exitCode: 0,
        oomKilled: false,
        memoryEventsDelta: { oom: 0, oom_kill: 0 },
        stdout: 'MEM_PROBE_START\nALLOCATED_16MB\nALLOCATION_FINISHED_WITHOUT_OOM\n',
      });

      expect(result.status).toBe(VERDICT_FAIL);
      expect(result.oomKilled).toBe(false);
      expect(result.explanation).toContain('Enforcement is inactive');
    });

    test('classifies probe timeout as FAIL', () => {
      const result = classifyMemoryEnforcement({
        timedOut: true,
        exitCode: 124,
      });

      expect(result.status).toBe(VERDICT_FAIL);
      expect(result.explanation).toContain('timed out');
    });

    test('classifies probe runtime error as FAIL', () => {
      const result = classifyMemoryEnforcement({
        error: 'Container start failed: OOM killed on daemon',
      });

      expect(result.status).toBe(VERDICT_FAIL);
      expect(result.explanation).toContain('Memory probe failed with error');
    });

    test('REGRESSION: classifies generic exitCode 137 without attributable OOM evidence as FAIL', () => {
      const result = classifyMemoryEnforcement({
        configuredLimitBytes: 128 * 1024 * 1024,
        exitCode: 137,
        oomKilled: false, // No Docker inspect OOM flag
        memoryEventsDelta: { oom: 0, oom_kill: 0 }, // No cgroup event delta
        stdout: 'MEM_PROBE_START\nALLOCATED_16MB\nALLOCATED_32MB\n',
      });

      expect(result.status).toBe(VERDICT_FAIL);
      expect(result.oomKilled).toBe(false);
      expect(result.exitCode).toBe(137);
      expect(result.explanation).toContain('Unattributed termination cannot be certified as cgroup memory enforcement');
    });

    test('classifies inaccessible cgroup memory metrics as UNSUPPORTED', () => {
      const result = classifyMemoryEnforcement({
        stdout: 'MEM_PROBE_START\nCGROUP_MEMORY_EVENTS_BEFORE:ERR:Permission denied\n',
        oomKilled: false,
      });

      expect(result.status).toBe(VERDICT_UNSUPPORTED);
      expect(result.explanation).toContain('memory.events metrics are inaccessible or unsupported');
    });
  });

  // --------------------------------------------------------------------------
  // 2. PID Limit Classifier
  // --------------------------------------------------------------------------
  describe('2. PID Limit Classifier', () => {
    test('classifies as PASS when fork() is blocked with EAGAIN/BlockingIOError at limit with corroborated cgroup delta', () => {
      const result = classifyPidEnforcement({
        configuredPidsLimit: 10,
        observedPidsMax: '10',
        childrenSpawned: 9,
        forkBlocked: true,
        pidsEventsDelta: { max: 1 },
        childrenReaped: 9,
        exitCode: 0,
        stdout: 'PID_PROBE_START\nCGROUP_PIDS_MAX:10\nFORK_BLOCKED_AT_9_CHILDREN: [Errno 11] Resource temporarily unavailable\nCGROUP_PIDS_EVENTS_DELTA:max=1\nREAPED_9_CHILDREN\n',
      });

      expect(result.status).toBe(VERDICT_PASS);
      expect(result.forkBlocked).toBe(true);
      expect(result.childrenSpawned).toBe(9);
      expect(result.explanation).toContain('PID limit enforced at 9 child processes');
      expect(result.explanation).toContain('pids.events max delta=1');
    });

    test('REGRESSION: classifies as FAIL when zero children were created', () => {
      const result = classifyPidEnforcement({
        configuredPidsLimit: 10,
        childrenSpawned: 0,
        forkBlocked: true,
        pidsEventsDelta: { max: 1 },
        stdout: 'PID_PROBE_START\nFORK_BLOCKED_AT_0_CHILDREN: [Errno 11] Resource temporarily unavailable\n',
      });

      expect(result.status).toBe(VERDICT_FAIL);
      expect(result.childrenSpawned).toBe(0);
      expect(result.explanation).toContain('zero children were created');
    });

    test('REGRESSION: classifies as FAIL when too few children were created', () => {
      const result = classifyPidEnforcement({
        configuredPidsLimit: 10,
        childrenSpawned: 2, // Far below plausible threshold of 6..10
        forkBlocked: true,
        pidsEventsDelta: { max: 1 },
        stdout: 'PID_PROBE_START\nFORK_BLOCKED_AT_2_CHILDREN: [Errno 11] Resource temporarily unavailable\n',
      });

      expect(result.status).toBe(VERDICT_FAIL);
      expect(result.explanation).toContain('Too few children spawned (2)');
    });

    test('REGRESSION: classifies as FAIL when fork was blocked but pids.events max did not increment', () => {
      const result = classifyPidEnforcement({
        configuredPidsLimit: 10,
        childrenSpawned: 9,
        forkBlocked: true,
        pidsEventsDelta: { max: 0 }, // No corroborating cgroup delta!
        stdout: 'PID_PROBE_START\nFORK_BLOCKED_AT_9_CHILDREN: [Errno 11] Resource temporarily unavailable\n',
      });

      expect(result.status).toBe(VERDICT_FAIL);
      expect(result.explanation).toContain('pids.events max hit counter did not increment');
    });

    test('REGRESSION: classifies as FAIL when observed pids.max does not match configured limit', () => {
      const result = classifyPidEnforcement({
        configuredPidsLimit: 10,
        observedPidsMax: '100', // Mismatched limit!
        childrenSpawned: 9,
        forkBlocked: true,
        pidsEventsDelta: { max: 1 },
      });

      expect(result.status).toBe(VERDICT_FAIL);
      expect(result.explanation).toContain('Observed pids.max (100) does not match configured limit (10)');
    });

    test('classifies as FAIL when fork loop was never restricted', () => {
      const result = classifyPidEnforcement({
        configuredPidsLimit: 10,
        childrenSpawned: 25,
        forkBlocked: false,
        exitCode: 1,
        stdout: 'PID_PROBE_START\nFORK_NEVER_BLOCKED\n',
      });

      expect(result.status).toBe(VERDICT_FAIL);
      expect(result.forkBlocked).toBe(false);
      expect(result.explanation).toContain('spawned past the configured limit of 10 without restriction');
    });

    test('classifies probe error as FAIL', () => {
      const result = classifyPidEnforcement({
        error: 'Docker daemon connection dropped during fork probe',
      });

      expect(result.status).toBe(VERDICT_FAIL);
      expect(result.explanation).toContain('PID probe failed with error');
    });

    test('classifies inaccessible cgroup pids.events metrics as UNSUPPORTED', () => {
      const result = classifyPidEnforcement({
        stdout: 'PID_PROBE_START\nCGROUP_PIDS_EVENTS_BEFORE:ERR:No such file\n',
      });

      expect(result.status).toBe(VERDICT_UNSUPPORTED);
      expect(result.explanation).toContain('pids.events metrics are inaccessible or unsupported');
    });
  });

  // --------------------------------------------------------------------------
  // 3. CPU Quota Classifier
  // --------------------------------------------------------------------------
  describe('3. CPU Quota Classifier', () => {
    test('classifies throttled CPU execution (~0.5 ratio, cgroup throttling) as PASS', () => {
      const result = classifyCpuEnforcement({
        requestedNanoCPUs: 500000000,
        wallSeconds: 2.0,
        processCpuSeconds: 1.024,
        cpuStatDelta: { nr_throttled: 28, throttled_usec: 980000 },
        stdout: 'CPU_PROBE_START\nWALL_TIME:2.0000\nCPU_TIME:1.0240\nCPU_RATIO:0.5120\n',
      });

      expect(result.status).toBe(VERDICT_PASS);
      expect(result.cpuRatio).toBeCloseTo(0.512, 2);
      expect(result.explanation).toContain('CPU quota enforced');
      expect(result.explanation).toContain('throttled periods=28');
    });

    test('classifies unthrottled execution (ratio >= 0.85 without throttle stats) as FAIL', () => {
      const result = classifyCpuEnforcement({
        requestedNanoCPUs: 500000000,
        wallSeconds: 2.0,
        processCpuSeconds: 1.95,
        cpuStatDelta: { nr_throttled: 0, throttled_usec: 0 },
        stdout: 'CPU_PROBE_START\nWALL_TIME:2.0000\nCPU_TIME:1.9500\nCPU_RATIO:0.9750\n',
      });

      expect(result.status).toBe(VERDICT_FAIL);
      expect(result.explanation).toContain('Workload executed unthrottled');
    });

    test('classifies probe error as FAIL', () => {
      const result = classifyCpuEnforcement({
        error: 'Execution timed out',
      });

      expect(result.status).toBe(VERDICT_FAIL);
      expect(result.explanation).toContain('CPU probe failed with error');
    });

    test('REGRESSION: classifies execution with ratio within tolerance (~0.50) but zero throttle stats as FAIL', () => {
      const result = classifyCpuEnforcement({
        requestedNanoCPUs: 500000000,
        wallSeconds: 2.0,
        processCpuSeconds: 1.0,
        cpuStatDelta: { nr_throttled: 0, throttled_usec: 0 }, // Zero throttle stats!
        stdout: 'CPU_PROBE_START\nWALL_TIME:2.0000\nCPU_TIME:1.0000\nCPU_RATIO:0.5000\n',
      });

      expect(result.status).toBe(VERDICT_FAIL);
      expect(result.explanation).toContain('CFS bandwidth limit was not enforced: cpu.stat reported zero throttled periods');
      expect(result.explanation).toContain('Timing ratio alone cannot certify CPU enforcement without kernel throttling evidence');
    });

    test('classifies inaccessible cgroup cpu.stat metrics as UNSUPPORTED', () => {
      const result = classifyCpuEnforcement({
        stdout: 'CPU_PROBE_START\nCGROUP_CPU_STAT_BEFORE:ERR:Permission denied\n',
      });

      expect(result.status).toBe(VERDICT_UNSUPPORTED);
      expect(result.explanation).toContain('cpu.stat metrics are inaccessible or unsupported');
    });
  });

  // --------------------------------------------------------------------------
  // 4. gVisor (runsc) Integration Classifier
  // --------------------------------------------------------------------------
  describe('4. gVisor (runsc) Integration Classifier', () => {
    test('classifies as PASS when /proc/version confirms gVisor identity inside container', () => {
      const result = classifyGvisorIntegration({
        runtimeRequested: 'runsc',
        runtimeRegistered: true,
        containerStarted: true,
        procVersion: 'Linux version 4.4.0 (gVisor release-20240101.0)',
        stdout: 'PROC_VERSION:Linux version 4.4.0 (gVisor release-20240101.0)\n',
      });

      expect(result.status).toBe(VERDICT_PASS);
      expect(result.sandboxVerified).toBe(true);
      expect(result.explanation).toContain('gVisor sandbox identity confirmed');
    });

    test('QUALIFICATION RULE: classifies WSL2 polkit/systemd error as BLOCKED (startup environment blocker)', () => {
      const result = classifyGvisorIntegration({
        runtimeRequested: 'runsc',
        runtimeRegistered: true,
        containerStarted: false,
        startupError: 'systemd error: Interactive authentication required',
      });

      expect(result.status).toBe(VERDICT_BLOCKED);
      expect(result.sandboxVerified).toBe(false);
      expect(result.explanation).toContain('Interactive authentication required');
      expect(result.explanation).toContain('WSL2/systemd polkit user-session authentication limitation');
    });

    test('classifies missing runsc runtime in daemon as BLOCKED', () => {
      const result = classifyGvisorIntegration({
        runtimeRequested: 'runsc',
        runtimeRegistered: false,
      });

      expect(result.status).toBe(VERDICT_BLOCKED);
      expect(result.sandboxVerified).toBe(false);
      expect(result.explanation).toContain("not registered in Docker daemon");
    });

    test('classifies container running on standard host kernel without gVisor as FAIL', () => {
      const result = classifyGvisorIntegration({
        runtimeRequested: 'runsc',
        runtimeRegistered: true,
        containerStarted: true,
        procVersion: 'Linux version 5.15.0-generic Ubuntu',
      });

      expect(result.status).toBe(VERDICT_FAIL);
      expect(result.sandboxVerified).toBe(false);
      expect(result.explanation).toContain('does not identify gVisor');
    });
  });

  // --------------------------------------------------------------------------
  // 5. Environment & Preflight Probing
  // --------------------------------------------------------------------------
  describe('5. Environment & Preflight Probing', () => {
    test('detects Windows platform and skips live stress probes safely', () => {
      const env = detectHostEnvironment({ platform: 'win32' });
      expect(env.platform).toBe('win32');

      const preflight = evaluatePreflight(env, {
        connected: true,
        serverVersion: '27.0.0',
        cgroupDriver: 'none',
        isRootless: false,
      });

      expect(preflight.canRunLiveProbes).toBe(false);
      expect(preflight.skipReason).toContain('Windows host detected');
      expect(preflight.strictFailure).toBe(false);
    });

    test('strict mode on Windows marks strictFailure as true', () => {
      const env = detectHostEnvironment({ platform: 'win32' });
      const preflight = evaluatePreflight(
        env,
        { connected: true, cgroupDriver: 'none', isRootless: false },
        { strict: true }
      );

      expect(preflight.canRunLiveProbes).toBe(false);
      expect(preflight.strictFailure).toBe(true);
    });

    test('detects WSL2 environment from kernel release string', () => {
      const env = detectHostEnvironment({
        platform: 'linux',
        kernelRelease: '5.15.153.1-microsoft-standard-WSL2',
      });

      expect(env.isWsl).toBe(true);
    });

    test('refuses live probes on a privileged rootful daemon by default (safety guard)', () => {
      const env = detectHostEnvironment({ platform: 'linux', kernelRelease: '5.15.0-generic' });
      const preflight = evaluatePreflight(env, {
        connected: true,
        cgroupDriver: 'systemd',
        isRootless: false, // Rootful / privileged daemon
      });

      expect(preflight.canRunLiveProbes).toBe(false);
      expect(preflight.skipReason).toContain('Connected Docker daemon is rootful');
    });

    test('permits live probes on an unprivileged rootless daemon with systemd driver', () => {
      const env = detectHostEnvironment({ platform: 'linux', kernelRelease: '5.15.0-generic' });
      const preflight = evaluatePreflight(env, {
        connected: true,
        cgroupDriver: 'systemd',
        isRootless: true,
      });

      expect(preflight.canRunLiveProbes).toBe(true);
      expect(preflight.skipReason).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // 6. Overall Verdict & Release-Blocking Determination
  // --------------------------------------------------------------------------
  describe('6. Overall Verdict Determination', () => {
    test('Windows environment ALWAYS results in NOT_QUALIFIED_FOR_PRODUCTION', () => {
      const verdict = resolveOverallVerdict(
        { platform: 'win32', isWsl: false },
        {
          memory: { status: VERDICT_PASS },
          pid: { status: VERDICT_PASS },
          cpu: { status: VERDICT_PASS },
          gvisor: { status: VERDICT_PASS },
        }
      );

      expect(verdict).toBe(STATUS_NOT_QUALIFIED);
    });

    test('WSL2 environment ALWAYS results in NOT_QUALIFIED_FOR_PRODUCTION (preliminary evidence only)', () => {
      const verdict = resolveOverallVerdict(
        { platform: 'linux', isWsl: true, isRootless: true, cgroupControllersEnforced: true },
        {
          memory: { status: VERDICT_PASS },
          pid: { status: VERDICT_PASS },
          cpu: { status: VERDICT_PASS },
          gvisor: { status: VERDICT_PASS },
        }
      );

      expect(verdict).toBe(STATUS_NOT_QUALIFIED);
    });

    test('Native Linux target qualifies ONLY when all controls pass and rootless cgroups are enforced', () => {
      const verdict = resolveOverallVerdict(
        {
          platform: 'linux',
          isWsl: false,
          connected: true,
          isRootless: true,
          cgroupControllersEnforced: true,
          cgroupDriver: 'systemd',
          cgroupVersion: '2',
        },
        {
          memory: { status: VERDICT_PASS },
          pid: { status: VERDICT_PASS },
          cpu: { status: VERDICT_PASS },
          gvisor: { status: VERDICT_PASS },
        }
      );

      expect(verdict).toBe(STATUS_QUALIFIED);
    });

    test('Native Linux target does NOT qualify if gVisor is BLOCKED or FAILED', () => {
      const verdict = resolveOverallVerdict(
        {
          platform: 'linux',
          isWsl: false,
          connected: true,
          isRootless: true,
          cgroupControllersEnforced: true,
        },
        {
          memory: { status: VERDICT_PASS },
          pid: { status: VERDICT_PASS },
          cpu: { status: VERDICT_PASS },
          gvisor: { status: VERDICT_BLOCKED },
        }
      );

      expect(verdict).toBe(STATUS_NOT_QUALIFIED);
    });

    test('REGRESSION: qualifies native Linux using 3-argument signature passing daemon probe results', () => {
      const env = { platform: 'linux', isWsl: false };
      const daemon = {
        connected: true,
        isRootless: true,
        cgroupControllersEnforced: true,
        cgroupDriver: 'systemd',
        cgroupVersion: '2',
      };
      const results = {
        memory: { status: VERDICT_PASS },
        pid: { status: VERDICT_PASS },
        cpu: { status: VERDICT_PASS },
        gvisor: { status: VERDICT_PASS },
      };

      const verdict = resolveOverallVerdict(env, daemon, results);
      expect(verdict).toBe(STATUS_QUALIFIED);
    });

    test('REGRESSION: disqualifies native Linux when daemon is rootful (not rootless)', () => {
      const env = { platform: 'linux', isWsl: false };
      const daemon = {
        connected: true,
        isRootless: false, // Rootful daemon!
        cgroupControllersEnforced: true,
      };
      const results = {
        memory: { status: VERDICT_PASS },
        pid: { status: VERDICT_PASS },
        cpu: { status: VERDICT_PASS },
        gvisor: { status: VERDICT_PASS },
      };

      const verdict = resolveOverallVerdict(env, daemon, results);
      expect(verdict).toBe(STATUS_NOT_QUALIFIED);
    });

    test('REGRESSION: disqualifies native Linux when daemon cgroup controllers are unenforced', () => {
      const env = { platform: 'linux', isWsl: false };
      const daemon = {
        connected: true,
        isRootless: true,
        cgroupControllersEnforced: false, // Unenforced cgroups!
      };
      const results = {
        memory: { status: VERDICT_PASS },
        pid: { status: VERDICT_PASS },
        cpu: { status: VERDICT_PASS },
        gvisor: { status: VERDICT_PASS },
      };

      const verdict = resolveOverallVerdict(env, daemon, results);
      expect(verdict).toBe(STATUS_NOT_QUALIFIED);
    });

    test('REGRESSION: disqualifies native Linux when daemon is disconnected or missing', () => {
      const env = { platform: 'linux', isWsl: false };
      const daemon = {
        connected: false,
        error: 'Cannot connect to daemon socket',
      };
      const results = {
        memory: { status: VERDICT_PASS },
        pid: { status: VERDICT_PASS },
        cpu: { status: VERDICT_PASS },
        gvisor: { status: VERDICT_PASS },
      };

      const verdict = resolveOverallVerdict(env, daemon, results);
      expect(verdict).toBe(STATUS_NOT_QUALIFIED);
    });

    test('REGRESSION: disqualifies when daemon says isRootless: false but environment says isRootless: true', () => {
      const env = { platform: 'linux', isWsl: false, isRootless: true, cgroupControllersEnforced: true, connected: true };
      const daemon = {
        connected: true,
        isRootless: false,
        cgroupControllersEnforced: true,
      };
      const results = {
        memory: { status: VERDICT_PASS },
        pid: { status: VERDICT_PASS },
        cpu: { status: VERDICT_PASS },
        gvisor: { status: VERDICT_PASS },
      };

      const verdict = resolveOverallVerdict(env, daemon, results);
      expect(verdict).toBe(STATUS_NOT_QUALIFIED);
    });

    test('REGRESSION: disqualifies when daemon cgroup enforcement is false or missing while environment says true', () => {
      const env = { platform: 'linux', isWsl: false, isRootless: true, cgroupControllersEnforced: true, connected: true };
      const results = {
        memory: { status: VERDICT_PASS },
        pid: { status: VERDICT_PASS },
        cpu: { status: VERDICT_PASS },
        gvisor: { status: VERDICT_PASS },
      };

      // Case A: daemon explicitly has cgroupControllersEnforced: false
      const daemonFalse = {
        connected: true,
        isRootless: true,
        cgroupControllersEnforced: false,
      };
      expect(resolveOverallVerdict(env, daemonFalse, results)).toBe(STATUS_NOT_QUALIFIED);

      // Case B: daemon is missing cgroupControllersEnforced entirely
      const daemonMissing = {
        connected: true,
        isRootless: true,
      };
      expect(resolveOverallVerdict(env, daemonMissing, results)).toBe(STATUS_NOT_QUALIFIED);
    });

    test('REGRESSION: disqualifies when daemon connected is missing while other fields claim success', () => {
      const env = { platform: 'linux', isWsl: false, connected: true, isRootless: true, cgroupControllersEnforced: true };
      const daemon = {
        // connected is omitted/missing
        isRootless: true,
        cgroupControllersEnforced: true,
      };
      const results = {
        memory: { status: VERDICT_PASS },
        pid: { status: VERDICT_PASS },
        cpu: { status: VERDICT_PASS },
        gvisor: { status: VERDICT_PASS },
      };

      const verdict = resolveOverallVerdict(env, daemon, results);
      expect(verdict).toBe(STATUS_NOT_QUALIFIED);
    });

    test('REGRESSION: qualifies native Linux when daemon fields are genuinely all true on qualifying fixture', () => {
      const env = {
        platform: 'linux',
        isWsl: false,
        connected: true,
        isRootless: true,
        cgroupControllersEnforced: true,
      };
      const daemon = {
        connected: true,
        isRootless: true,
        cgroupControllersEnforced: true,
        cgroupDriver: 'systemd',
        cgroupVersion: '2',
      };
      const results = {
        memory: { status: VERDICT_PASS },
        pid: { status: VERDICT_PASS },
        cpu: { status: VERDICT_PASS },
        gvisor: { status: VERDICT_PASS },
      };

      const verdict = resolveOverallVerdict(env, daemon, results);
      expect(verdict).toBe(STATUS_QUALIFIED);
    });

    test('REGRESSION: Windows and WSL2 remain disqualified even when all daemon and probe inputs are mocked as passing', () => {
      const daemonPassing = {
        connected: true,
        isRootless: true,
        cgroupControllersEnforced: true,
        cgroupDriver: 'systemd',
        cgroupVersion: '2',
      };
      const resultsPassing = {
        memory: { status: VERDICT_PASS },
        pid: { status: VERDICT_PASS },
        cpu: { status: VERDICT_PASS },
        gvisor: { status: VERDICT_PASS },
      };

      // Mock Windows host with all daemon and probe fields passing
      const winEnv = { platform: 'win32', isWsl: false, connected: true, isRootless: true, cgroupControllersEnforced: true };
      expect(resolveOverallVerdict(winEnv, daemonPassing, resultsPassing)).toBe(STATUS_NOT_QUALIFIED);

      // Mock WSL2 host with all daemon and probe fields passing
      const wslEnv = { platform: 'linux', isWsl: true, connected: true, isRootless: true, cgroupControllersEnforced: true };
      expect(resolveOverallVerdict(wslEnv, daemonPassing, resultsPassing)).toBe(STATUS_NOT_QUALIFIED);
    });
  });

  // --------------------------------------------------------------------------
  // 7. Sanitization & Reporting
  // --------------------------------------------------------------------------
  describe('7. Sanitization & Reporting', () => {
    test('sanitizes connection URLs, tokens, and passwords in reports', () => {
      const raw = {
        endpoint: 'redis://user:superSecretPassword123@10.0.0.1:6379/0',
        redis_password: 'superSecretPassword123',
        nested: {
          token: 'jwt-token-abcdef12345',
          safeValue: 42,
        },
      };

      const cleaned = sanitizeDetails(raw);
      expect(cleaned.endpoint).toBe('redis://user:***@10.0.0.1:6379/0');
      expect(cleaned.redis_password).toBe('***');
      expect(cleaned.nested.token).toBe('***');
      expect(cleaned.nested.safeValue).toBe(42);
    });

    test('generateSummaryMarkdown includes required notice on WSL2 and Windows', () => {
      const mdWsl = generateSummaryMarkdown({
        runId: 'test-wsl-run',
        environment: { platform: 'linux', isWsl: true },
        verdict: STATUS_NOT_QUALIFIED,
      });

      expect(mdWsl).toContain('WSL2 Environment Detected');
      expect(mdWsl).toContain('NOT_QUALIFIED_FOR_PRODUCTION');

      const mdWin = generateSummaryMarkdown({
        runId: 'test-win-run',
        environment: { platform: 'win32', isWsl: false },
        verdict: STATUS_NOT_QUALIFIED,
      });

      expect(mdWin).toContain('Windows Host Detected');
    });
  });

  // --------------------------------------------------------------------------
  // 8. Enforcement Tracker Isolation
  // --------------------------------------------------------------------------
  describe('8. Enforcement Tracker Container Isolation', () => {
    test('tracker registers and removes only its own tracked container IDs', async () => {
      const tracker = new EnforcementTracker('test-run-1');
      tracker.track('container-abc');
      tracker.track('container-def');

      expect(tracker.createdContainerIds.has('container-abc')).toBe(true);
      expect(tracker.createdContainerIds.has('container-def')).toBe(true);
      expect(tracker.createdContainerIds.has('container-unrelated')).toBe(false);

      const removedIds = [];
      const mockDocker = {
        getContainer: (id) => ({
          remove: async () => {
            removedIds.push(id);
          },
        }),
      };

      await tracker.cleanup(mockDocker);

      expect(removedIds).toEqual(['container-abc', 'container-def']);
      expect(tracker.createdContainerIds.size).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // 9. Stream Error Handling & Signal Lifecycle (Findings 4 & 5)
  // --------------------------------------------------------------------------
  describe('9. Stream Error Handling & Signal Lifecycle (Findings 4 & 5)', () => {
    test('executeProbeContainer captures stream errors, preserves output, sets error flag, and runs cleanup', async () => {
      const tracker = new EnforcementTracker('test-stream-error');
      const { PassThrough } = require('stream');
      const mockStream = new PassThrough();

      let containerRemoved = false;
      const mockContainer = {
        id: 'mock-stream-err-container',
        attach: async () => mockStream,
        start: async () => {},
        wait: async () => {
          // Emit stream error during execution
          mockStream.emit('error', new Error('premature socket close on daemon'));
          return { StatusCode: 0 };
        },
        inspect: async () => ({ State: { ExitCode: 0 } }),
        remove: async () => {
          containerRemoved = true;
        },
      };

      const mockDocker = {
        createContainer: async () => mockContainer,
        modem: {
          demuxStream: (src, stdout) => {
            stdout.write('PARTIAL_OUTPUT_BEFORE_ERROR');
          },
        },
      };

      const result = await executeProbeContainer(mockDocker, tracker, {
        probeName: 'stream-test',
        code: 'print("hello")',
      });

      expect(result.error).toContain('Stream error: premature socket close on daemon');
      expect(result.stdout).toContain('PARTIAL_OUTPUT_BEFORE_ERROR');
      expect(containerRemoved).toBe(true);
      expect(tracker.createdContainerIds.size).toBe(0);
    });

    test('runHarness cleanly removes SIGINT and SIGTERM listeners without accumulation', async () => {
      const initialSigintCount = process.listenerCount('SIGINT');
      const initialSigtermCount = process.listenerCount('SIGTERM');

      // Programmatic invocation of runHarness
      await runHarness({ save: false });

      const finalSigintCount = process.listenerCount('SIGINT');
      const finalSigtermCount = process.listenerCount('SIGTERM');

      expect(finalSigintCount).toBe(initialSigintCount);
      expect(finalSigtermCount).toBe(initialSigtermCount);
    });
  });

  // --------------------------------------------------------------------------
  // 10. Generated Probe Workload Syntax & Python 3.11 Compatibility
  // --------------------------------------------------------------------------
  describe('10. Generated Probe Workload Syntax & Python 3.11 Compatibility', () => {
    test('generated probe scripts use safe string concatenation with splitlines and eliminate nested quote f-strings', () => {
      const memoryScript = buildMemoryProbeScript();
      const pidScript = buildPidProbeScript();
      const cpuScript = buildCpuProbeScript();
      const gvisorScript = buildGvisorProbeScript();

      const allScripts = [
        { name: 'memory', code: memoryScript },
        { name: 'pid', code: pidScript },
        { name: 'cpu', code: cpuScript },
        { name: 'gvisor', code: gvisorScript },
      ];

      for (const { name, code } of allScripts) {
        expect(code.length).toBeGreaterThan(0);

        // REGRESSION CHECK: No line should attempt replace(chr(10), ...) inside f-strings
        expect(code).not.toMatch(/replace\(chr\(10\)/);

        // No nested quotes inside f-strings (disallowed in Python < 3.12)
        const lines = code.split('\n');
        for (const line of lines) {
          const doubleQuotedFStrings = line.matchAll(/f"([^"\\]*(?:\\.[^"\\]*)*)"/g);
          for (const match of doubleQuotedFStrings) {
            const inner = match[1];
            const exprs = inner.matchAll(/\{(.*?)\}/g);
            for (const expr of exprs) {
              expect(expr[1]).not.toContain('"');
              expect(expr[1]).not.toContain('\\');
            }
          }
        }
      }

      // Explicit verification of splitlines() safe concatenation in probe scripts
      expect(memoryScript).toContain('print("CGROUP_MEMORY_EVENTS_BEFORE:" + ",".join(ev_before.splitlines()))');
      expect(memoryScript).toContain('print("CGROUP_MEMORY_EVENTS_AFTER:" + ",".join(ev_after.splitlines()))');

      expect(pidScript).toContain('print("CGROUP_PIDS_EVENTS_BEFORE:" + ",".join(ev_before.splitlines()))');
      expect(pidScript).toContain('print("CGROUP_PIDS_EVENTS_AFTER:" + ",".join(ev_after.splitlines()))');

      expect(cpuScript).toContain('print("CGROUP_CPU_STAT_BEFORE:" + ",".join(st_before.splitlines()))');
      expect(cpuScript).toContain('print("CGROUP_CPU_STAT_AFTER:" + ",".join(st_after.splitlines()))');
    });

    test('validates generated workload scripts via Python ast parser when Python is available', () => {
      const { spawnSync } = require('child_process');
      const pyVersionCheck = spawnSync('python', ['--version'], { encoding: 'utf8' });
      const pythonAvailable = pyVersionCheck.status === 0;

      if (!pythonAvailable) {
        // Report honestly if python runtime is absent from test environment
        console.warn('Python runtime is not available on PATH; skipping external ast.parse compilation check.');
        return;
      }

      const scripts = [
        { name: 'memory', code: buildMemoryProbeScript() },
        { name: 'pid', code: buildPidProbeScript() },
        { name: 'cpu', code: buildCpuProbeScript() },
        { name: 'gvisor', code: buildGvisorProbeScript() },
      ];

      for (const { name, code } of scripts) {
        const result = spawnSync('python', ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'], {
          input: code,
          encoding: 'utf8',
        });
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
      }
    });

    test('probe runner functions pass the built scripts to container Cmd argument', async () => {
      const tracker = new EnforcementTracker('test-script-dispatch');
      const passedCodes = {};

      const createMockDocker = (probeKey) => ({
        createContainer: async (opts) => {
          passedCodes[probeKey] = opts.Cmd?.[1];
          return {
            id: `mock-container-${probeKey}`,
            attach: async () => {
              const { PassThrough } = require('stream');
              return new PassThrough();
            },
            start: async () => {},
            wait: async () => ({ StatusCode: 0 }),
            inspect: async () => ({ State: { ExitCode: 0 } }),
            remove: async () => {},
          };
        },
        modem: {
          demuxStream: () => {},
        },
      });

      await probeMemoryEnforcement(createMockDocker('memory'), tracker);
      expect(passedCodes.memory).toBe(buildMemoryProbeScript());

      await probePidEnforcement(createMockDocker('pid'), tracker);
      expect(passedCodes.pid).toBe(buildPidProbeScript());

      await probeCpuEnforcement(createMockDocker('cpu'), tracker);
      expect(passedCodes.cpu).toBe(buildCpuProbeScript());

      await probeGvisorIntegration(createMockDocker('gvisor'), tracker, { hasRunsc: true });
      expect(passedCodes.gvisor).toBe(buildGvisorProbeScript());
    });
  });
});
