/**
 * CodeCollab M1.1 — Resource Enforcement Probes
 *
 * Implements bounded, non-destructive test probes for Memory, PID limits,
 * CPU CFS throttling, and explicit gVisor (runsc) integration.
 * Guarantees precise tracking and cleanup of all created containers.
 */

const crypto = require('crypto');
const { PassThrough } = require('stream');

/**
 * Tracks containers created during an evaluation run and handles isolated cleanup.
 */
class EnforcementTracker {
  constructor(runId) {
    this.runId = runId || `eval-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    this.createdContainerIds = new Set();
  }

  /**
   * Registers a container created during this evaluation run.
   *
   * @param {string} containerId
   */
  track(containerId) {
    if (containerId) {
      this.createdContainerIds.add(containerId);
    }
  }

  /**
   * Removes a container from active tracking once destroyed.
   *
   * @param {string} containerId
   */
  untrack(containerId) {
    if (containerId) {
      this.createdContainerIds.delete(containerId);
    }
  }

  /**
   * Cleans up ONLY the containers created by this run ID.
   * Does not prune containers created by other runs or tests.
   *
   * @param {Object} dockerClient
   */
  async cleanup(dockerClient) {
    if (!dockerClient || this.createdContainerIds.size === 0) return;

    const ids = Array.from(this.createdContainerIds);
    for (const id of ids) {
      try {
        const container = dockerClient.getContainer(id);
        await container.remove({ force: true });
        this.untrack(id);
      } catch (err) {
        // Preserve failed removals for retry and qualification evidence.
        if (err.statusCode === 404) this.untrack(id);
      }
    }
  }
}

/**
 * Executes a containerized probe workload with stream capture, bounded timeout, and inspection.
 *
 * @param {Object} dockerClient
 * @param {EnforcementTracker} tracker
 * @param {Object} config
 * @returns {Promise<Object>} { stdout, stderr, exitCode, timedOut, inspectData, error }
 */
/**
 * Executes a containerized probe workload with stream capture, bounded timeout, inspection,
 * and robust stream error handling.
 *
 * @param {Object} dockerClient
 * @param {EnforcementTracker} tracker
 * @param {Object} config
 * @returns {Promise<Object>} { stdout, stderr, exitCode, timedOut, inspectData, error }
 */
async function executeProbeContainer(dockerClient, tracker, config = {}) {
  const {
    image = 'codecollab-runner-python:latest',
    code = '',
    hostConfig = {},
    timeoutMs = 6000,
    probeName = 'generic',
  } = config;

  let container = null;
  let timer = null;
  let timedOut = false;
  let streamError = null;

  try {
    container = await dockerClient.createContainer({
      Image: image,
      Cmd: ['--code', code],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      User: 'sandbox',
      Labels: {
        'codecollab.eval.runId': tracker.runId,
        'codecollab.eval.probe': probeName,
      },
      HostConfig: {
        Runtime: 'runsc', // Every qualification probe uses the required isolation runtime.
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        NetworkMode: 'none',
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=32m' },
        ...hostConfig,
      },
    });

    tracker.track(container.id);

    const stream = await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
    });

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    let stdout = '';
    let stderr = '';

    const handleStreamErr = (err) => {
      if (!streamError && err) {
        streamError = err;
      }
    };

    stream.on('error', handleStreamErr);
    stdoutStream.on('error', handleStreamErr);
    stderrStream.on('error', handleStreamErr);

    stdoutStream.on('data', (c) => { stdout += c.toString('utf8'); });
    stderrStream.on('data', (c) => { stderr += c.toString('utf8'); });

    dockerClient.modem.demuxStream(stream, stdoutStream, stderrStream);

    await container.start();

    const waitPromise = container.wait().then((data) => ({ timedOut: false, data }));
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(async () => {
        timedOut = true;
        try {
          await container.kill();
        } catch (_) {}
        resolve({ timedOut: true });
      }, timeoutMs);
    });

    const outcome = await Promise.race([waitPromise, timeoutPromise]);
    if (timer) clearTimeout(timer);

    // Wait briefly for stream buffers to flush
    await new Promise((r) => setTimeout(r, 50));

    let inspectData = null;
    try {
      inspectData = await container.inspect();
    } catch (_) {}

    const exitCode = outcome?.data && typeof outcome.data.StatusCode === 'number'
      ? outcome.data.StatusCode
      : (inspectData?.State?.ExitCode !== undefined ? inspectData.State.ExitCode : (timedOut ? 124 : 0));

    const finalError = streamError ? `Stream error: ${streamError.message}` : null;

    return {
      stdout,
      stderr,
      exitCode,
      timedOut,
      inspectData,
      error: finalError,
    };
  } catch (err) {
    if (timer) clearTimeout(timer);
    return {
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      inspectData: null,
      error: err.message,
    };
  } finally {
    if (container) {
      try {
        await container.remove({ force: true });
        tracker.untrack(container.id);
      } catch (err) {
        if (err.statusCode === 404) tracker.untrack(container.id);
      }
    }
  }
}

/**
 * Generates the Python workload script for the memory enforcement probe.
 * Written for compatibility with Python 3.11+ without nested quote f-string expressions.
 *
 * @returns {string}
 */
function buildMemoryProbeScript() {
  return [
    'import os, sys, time',
    'def read_cgroup(p):',
    '    try:',
    '        with open(p, "r") as f: return f.read().strip()',
    '    except Exception as e: return f"ERR:{e}"',
    'def parse_ev(raw):',
    '    d = {}',
    '    for line in raw.splitlines():',
    '        pts = line.strip().split()',
    '        if len(pts) == 2: d[pts[0]] = int(pts[1]) if pts[1].isdigit() else pts[1]',
    '    return d',
    'print("MEM_PROBE_START")',
    'mmax = read_cgroup("/sys/fs/cgroup/memory.max")',
    'print(f"CGROUP_MEMORY_MAX:{mmax}")',
    'ev_before = read_cgroup("/sys/fs/cgroup/memory.events")',
    'print("CGROUP_MEMORY_EVENTS_BEFORE:" + ",".join(ev_before.splitlines()))',
    'sys.stdout.flush()',
    'pid = os.fork()',
    'if pid == 0:',
    '    chunks = []',
    '    CHUNK_SIZE = 16 * 1024 * 1024',
    '    MAX_CHUNKS = 12',
    '    try:',
    '        for i in range(1, MAX_CHUNKS + 1):',
    '            chunk = bytearray(CHUNK_SIZE)',
    '            for j in range(0, CHUNK_SIZE, 4096): chunk[j] = 1',
    '            chunks.append(chunk)',
    '            print(f"ALLOCATED_{i * 16}MB")',
    '            sys.stdout.flush()',
    '            time.sleep(0.03)',
    '        print("ALLOCATION_FINISHED_WITHOUT_OOM")',
    '        sys.stdout.flush()',
    '        os._exit(0)',
    '    except MemoryError:',
    '        print("PYTHON_MEMORY_ERROR")',
    '        sys.stdout.flush()',
    '        os._exit(1)',
    'else:',
    '    _, status = os.waitpid(pid, 0)',
    '    exit_code = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else (status >> 8 if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))',
    '    print(f"CHILD_EXIT_STATUS:{exit_code}")',
    '    time.sleep(0.05)',
    '    ev_after = read_cgroup("/sys/fs/cgroup/memory.events")',
    '    print("CGROUP_MEMORY_EVENTS_AFTER:" + ",".join(ev_after.splitlines()))',
    '    b_d = parse_ev(ev_before)',
    '    a_d = parse_ev(ev_after)',
    '    delta_oom_kill = a_d.get("oom_kill", 0) - b_d.get("oom_kill", 0)',
    '    delta_oom = a_d.get("oom", 0) - b_d.get("oom", 0)',
    '    print(f"CGROUP_MEMORY_EVENTS_DELTA:oom_kill={delta_oom_kill},oom={delta_oom}")',
    '    sys.stdout.flush()',
    '    sys.exit(exit_code if exit_code != 0 else 0)',
  ].join('\n');
}

/**
 * Runs the memory enforcement probe with a bounded allocation and reads cgroup memory.events.
 *
 * @param {Object} dockerClient
 * @param {EnforcementTracker} tracker
 * @param {Object} [options]
 * @returns {Promise<Object>} Evidence object for classifyMemoryEnforcement()
 */
async function probeMemoryEnforcement(dockerClient, tracker, options = {}) {
  const limitBytes = options.memoryBytes || 128 * 1024 * 1024; // 128 MiB

  // Python workload: supervisor inspects cgroup memory.max and memory.events before/after child allocation
  const pythonScript = buildMemoryProbeScript();

  const result = await executeProbeContainer(dockerClient, tracker, {
    probeName: 'memory',
    code: pythonScript,
    hostConfig: {
      Memory: limitBytes,
      MemorySwap: limitBytes, // Disable additional swap space
      NanoCPUs: 500000000,
      PidsLimit: 64,
    },
    timeoutMs: options.timeoutMs || 8000,
  });

  const oomKilled = Boolean(result.inspectData?.State?.OOMKilled);

  // Parse cgroup metrics from stdout
  const matchMax = result.stdout.match(/CGROUP_MEMORY_MAX:(\S+)/);
  const observedMemoryMax = matchMax ? matchMax[1] : null;

  const matchDelta = result.stdout.match(/CGROUP_MEMORY_EVENTS_DELTA:([^\r\n]+)/);
  const memoryEventsDelta = {};
  if (matchDelta) {
    for (const pair of matchDelta[1].split(',')) {
      const [k, v] = pair.split('=');
      if (k && v !== undefined) memoryEventsDelta[k.trim()] = parseInt(v.trim(), 10) || 0;
    }
  }

  return {
    configuredLimitBytes: limitBytes,
    observedMemoryMax,
    exitCode: result.exitCode,
    oomKilled: oomKilled || (Number(memoryEventsDelta.oom_kill || 0) > 0),
    memoryEventsDelta,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    error: result.error,
  };
}

/**
 * Generates the Python workload script for the PID limit enforcement probe.
 * Written for compatibility with Python 3.11+ without nested quote f-string expressions.
 *
 * @returns {string}
 */
function buildPidProbeScript(pidsLimit = 10) {
  if (!Number.isInteger(pidsLimit) || pidsLimit < 1 || pidsLimit > 64) {
    throw new Error('PID probe limit must be an integer between 1 and 64');
  }
  return [
    'import os, sys, time, signal',
    'def read_cgroup(p):',
    '    try:',
    '        with open(p, "r") as f: return f.read().strip()',
    '    except Exception as e: return f"ERR:{e}"',
    'def parse_ev(raw):',
    '    d = {}',
    '    for line in raw.splitlines():',
    '        pts = line.strip().split()',
    '        if len(pts) == 2: d[pts[0]] = int(pts[1]) if pts[1].isdigit() else pts[1]',
    '    return d',
    'print("PID_PROBE_START")',
    'pmax = read_cgroup("/sys/fs/cgroup/pids.max")',
    'print(f"CGROUP_PIDS_MAX:{pmax}")',
    'ev_before = read_cgroup("/sys/fs/cgroup/pids.events")',
    'print("CGROUP_PIDS_EVENTS_BEFORE:" + ",".join(ev_before.splitlines()))',
    'sys.stdout.flush()',
    'children = []',
    `max_attempts = ${pidsLimit + 15}`,
    'fork_blocked = False',
    'error_msg = ""',
    'try:',
    '    for i in range(max_attempts):',
    '        try:',
    '            pid = os.fork()',
    '            if pid == 0:',
    '                try:',
    '                    time.sleep(10)',
    '                except:',
    '                    pass',
    '                os._exit(0)',
    '            else:',
    '                children.append(pid)',
    '                print(f"FORKED_{i+1}")',
    '                sys.stdout.flush()',
    '                time.sleep(0.02)',
    '        except (BlockingIOError, OSError) as e:',
    '            fork_blocked = True',
    '            error_msg = str(e)',
    '            print(f"FORK_BLOCKED_AT_{len(children)}_CHILDREN: {e}")',
    '            sys.stdout.flush()',
    '            break',
    'finally:',
    '    ev_after = read_cgroup("/sys/fs/cgroup/pids.events")',
    '    print("CGROUP_PIDS_EVENTS_AFTER:" + ",".join(ev_after.splitlines()))',
    '    b_d = parse_ev(ev_before)',
    '    a_d = parse_ev(ev_after)',
    '    delta_max = a_d.get("max", 0) - b_d.get("max", 0)',
    '    print(f"CGROUP_PIDS_EVENTS_DELTA:max={delta_max}")',
    '    sys.stdout.flush()',
    '    reaped = 0',
    '    cleanup_failures = []',
    '    for pid in children:',
    '        try:',
    '            os.kill(pid, signal.SIGKILL)',
    '        except ProcessLookupError:',
    '            pass',
    '        except Exception as e:',
    '            cleanup_failures.append(f"kill({pid}):{e}")',
    '    for pid in children:',
    '        try:',
    '            wpid, _ = os.waitpid(pid, 0)',
    '            if wpid == pid:',
    '                reaped += 1',
    '            else:',
    '                cleanup_failures.append(f"waitpid({pid}):unexpected_pid={wpid}")',
    '        except Exception as e:',
    '            cleanup_failures.append(f"waitpid({pid}):{e}")',
    '    print(f"REAPED_{reaped}_CHILDREN")',
    '    if cleanup_failures:',
    '        print("CLEANUP_FAILURES:" + ";".join(cleanup_failures))',
    '    sys.stdout.flush()',
    'if fork_blocked and len(children) > 0 and reaped == len(children) and not cleanup_failures:',
    '    sys.exit(0)',
    'else:',
    '    if not fork_blocked:',
    '        print("FORK_NEVER_BLOCKED")',
    '    if reaped != len(children):',
    '        print(f"REAP_INCOMPLETE:spawned={len(children)},reaped={reaped}")',
    '    sys.exit(1)',
  ].join('\n');
}

/**
 * Runs the PID limit enforcement probe with a bounded fork loop and reads cgroup pids.events.
 *
 * @param {Object} dockerClient
 * @param {EnforcementTracker} tracker
 * @param {Object} [options]
 * @returns {Promise<Object>} Evidence object for classifyPidEnforcement()
 */
async function probePidEnforcement(dockerClient, tracker, options = {}) {
  const pidsLimit = options.pidsLimit || 10;

  // Python workload: inspects pids.max and pids.events before/after sequential fork loop, reaps all children
  const pythonScript = buildPidProbeScript(pidsLimit);

  const result = await executeProbeContainer(dockerClient, tracker, {
    probeName: 'pid',
    code: pythonScript,
    hostConfig: {
      PidsLimit: pidsLimit,
      Memory: 256 * 1024 * 1024,
      MemorySwap: 256 * 1024 * 1024,
      NanoCPUs: 500000000,
    },
    timeoutMs: options.timeoutMs || 8000,
  });

  const matchSpawned = result.stdout.match(/FORK_BLOCKED_AT_(\d+)_CHILDREN/);
  const childrenSpawned = matchSpawned ? parseInt(matchSpawned[1], 10) : (result.stdout.match(/FORKED_\d+/g) || []).length;
  const matchReaped = result.stdout.match(/REAPED_(\d+)_CHILDREN/);
  const childrenReaped = matchReaped ? parseInt(matchReaped[1], 10) : null;
  const forkBlocked = result.stdout.includes('FORK_BLOCKED_AT_') || /BlockingIOError|Resource temporarily unavailable|Errno 11/i.test(result.stdout);

  const matchMax = result.stdout.match(/CGROUP_PIDS_MAX:(\S+)/);
  const observedPidsMax = matchMax ? matchMax[1] : null;

  const matchDelta = result.stdout.match(/CGROUP_PIDS_EVENTS_DELTA:([^\r\n]+)/);
  const pidsEventsDelta = {};
  if (matchDelta) {
    for (const pair of matchDelta[1].split(',')) {
      const [k, v] = pair.split('=');
      if (k && v !== undefined) pidsEventsDelta[k.trim()] = parseInt(v.trim(), 10) || 0;
    }
  }

  const matchCleanupFailures = result.stdout.match(/CLEANUP_FAILURES:([^\r\n]+)/);
  const cleanupFailures = matchCleanupFailures
    ? matchCleanupFailures[1].split(';').map((s) => s.trim()).filter(Boolean)
    : [];

  return {
    configuredPidsLimit: pidsLimit,
    observedPidsMax,
    childrenSpawned,
    forkBlocked,
    pidsEventsDelta,
    childrenReaped,
    cleanupFailures,
    timedOut: result.timedOut,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
}

/**
 * Generates the Python workload script for the CPU quota enforcement probe.
 * Written for compatibility with Python 3.11+ without nested quote f-string expressions.
 *
 * @returns {string}
 */
function buildCpuProbeScript() {
  return [
    'import time, sys',
    'def read_cgroup(p):',
    '    try:',
    '        with open(p, "r") as f: return f.read().strip()',
    '    except Exception as e: return f"ERR:{e}"',
    'def parse_st(raw):',
    '    d = {}',
    '    for line in raw.splitlines():',
    '        pts = line.strip().split()',
    '        if len(pts) == 2: d[pts[0]] = int(pts[1]) if pts[1].isdigit() else pts[1]',
    '    return d',
    'print("CPU_PROBE_START")',
    'cmax = read_cgroup("/sys/fs/cgroup/cpu.max")',
    'print(f"CGROUP_CPU_MAX:{cmax}")',
    'st_before = read_cgroup("/sys/fs/cgroup/cpu.stat")',
    'print("CGROUP_CPU_STAT_BEFORE:" + ",".join(st_before.splitlines()))',
    'sys.stdout.flush()',
    'TARGET_WALL_SECONDS = 2.0',
    'start_wall = time.monotonic()',
    'start_cpu = time.process_time()',
    'counter = 0',
    'while (time.monotonic() - start_wall) < TARGET_WALL_SECONDS:',
    '    for _ in range(1000): counter += 1',
    'elapsed_wall = time.monotonic() - start_wall',
    'elapsed_cpu = time.process_time() - start_cpu',
    'ratio = elapsed_cpu / elapsed_wall if elapsed_wall > 0 else 0',
    'st_after = read_cgroup("/sys/fs/cgroup/cpu.stat")',
    'print("CGROUP_CPU_STAT_AFTER:" + ",".join(st_after.splitlines()))',
    'b_s = parse_st(st_before)',
    'a_s = parse_st(st_after)',
    'd_nr_throttled = a_s.get("nr_throttled", 0) - b_s.get("nr_throttled", 0)',
    'd_throttled_usec = a_s.get("throttled_usec", 0) - b_s.get("throttled_usec", 0)',
    'd_nr_periods = a_s.get("nr_periods", 0) - b_s.get("nr_periods", 0)',
    'print(f"CGROUP_CPU_STAT_DELTA:nr_throttled={d_nr_throttled},throttled_usec={d_throttled_usec},nr_periods={d_nr_periods}")',
    'print(f"WALL_TIME:{elapsed_wall:.4f}")',
    'print(f"CPU_TIME:{elapsed_cpu:.4f}")',
    'print(f"CPU_RATIO:{ratio:.4f}")',
    'sys.stdout.flush()',
  ].join('\n');
}

/**
 * Runs the CPU quota probe measuring process CPU time vs. wall time and reads cgroup cpu.stat deltas.
 *
 * @param {Object} dockerClient
 * @param {EnforcementTracker} tracker
 * @param {Object} [options]
 * @returns {Promise<Object>} Evidence object for classifyCpuEnforcement()
 */
async function probeCpuEnforcement(dockerClient, tracker, options = {}) {
  const nanoCPUs = options.nanoCPUs || 500000000; // 0.5 CPU

  // Python workload: reads cpu.max and cpu.stat before/after busy arithmetic loop
  const pythonScript = buildCpuProbeScript();

  const result = await executeProbeContainer(dockerClient, tracker, {
    probeName: 'cpu',
    code: pythonScript,
    hostConfig: {
      NanoCPUs: nanoCPUs,
      Memory: 256 * 1024 * 1024,
      MemorySwap: 256 * 1024 * 1024,
      PidsLimit: 64,
    },
    timeoutMs: options.timeoutMs || 8000,
  });

  const matchWall = result.stdout.match(/WALL_TIME:([\d.]+)/);
  const matchCpu = result.stdout.match(/CPU_TIME:([\d.]+)/);
  const wallSeconds = matchWall ? parseFloat(matchWall[1]) : 0;
  const processCpuSeconds = matchCpu ? parseFloat(matchCpu[1]) : 0;

  const matchMax = result.stdout.match(/CGROUP_CPU_MAX:([^\r\n]+)/);
  const observedCpuMax = matchMax ? matchMax[1].trim() : null;

  const matchDelta = result.stdout.match(/CGROUP_CPU_STAT_DELTA:([^\r\n]+)/);
  const cpuStatDelta = {};
  if (matchDelta) {
    for (const pair of matchDelta[1].split(',')) {
      const [k, v] = pair.split('=');
      if (k && v !== undefined) cpuStatDelta[k.trim()] = parseInt(v.trim(), 10) || 0;
    }
  }

  return {
    requestedNanoCPUs: nanoCPUs,
    timedOut: result.timedOut,
    observedCpuMax,
    wallSeconds,
    processCpuSeconds,
    cpuStatDelta,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
}

/**
 * Generates the Python workload script for the gVisor sandbox integration probe.
 *
 * @returns {string}
 */
function buildGvisorProbeScript() {
  return [
    'import sys',
    'try:',
    '    with open("/proc/version", "r") as f:',
    '        v = f.read().strip()',
    '    print(f"PROC_VERSION:{v}")',
    'except Exception as e:',
    '    print(f"PROC_VERSION_ERR:{e}")',
  ].join('\n');
}

/**
 * Runs explicit gVisor (runsc) integration probe and verifies sandbox identity.
 *
 * @param {Object} dockerClient
 * @param {EnforcementTracker} tracker
 * @param {Object} daemonInfo
 * @param {Object} [options]
 * @returns {Promise<Object>} Evidence object for classifyGvisorIntegration()
 */
async function probeGvisorIntegration(dockerClient, tracker, daemonInfo = {}, options = {}) {
  const runtimeRegistered = Boolean(daemonInfo.hasRunsc);

  if (!runtimeRegistered) {
    return {
      runtimeRequested: 'runsc',
      runtimeRegistered: false,
      containerStarted: false,
      procVersion: '',
      startupError: "gVisor (runsc) is not registered in Docker daemon (daemon.json).",
    };
  }

  // Workload to inspect /proc/version from inside container
  const pythonScript = buildGvisorProbeScript();

  const result = await executeProbeContainer(dockerClient, tracker, {
    probeName: 'gvisor',
    code: pythonScript,
    hostConfig: {
      Runtime: 'runsc', // Explicitly requested runtime
      Memory: 256 * 1024 * 1024,
      MemorySwap: 256 * 1024 * 1024,
      NanoCPUs: 500000000,
      PidsLimit: 64,
    },
    timeoutMs: options.timeoutMs || 8000,
  });

  const matchProc = result.stdout.match(/PROC_VERSION:(.+)/);
  const procVersion = matchProc ? matchProc[1].trim() : '';

  return {
    runtimeRequested: 'runsc',
    runtimeRegistered: true,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    containerStarted: result.error === null,
    procVersion,
    startupError: result.error,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

module.exports = {
  EnforcementTracker,
  executeProbeContainer,
  probeMemoryEnforcement,
  probePidEnforcement,
  probeCpuEnforcement,
  probeGvisorIntegration,
  buildMemoryProbeScript,
  buildPidProbeScript,
  buildCpuProbeScript,
  buildGvisorProbeScript,
};
