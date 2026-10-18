const path = require('path');
const { URL } = require('url');

const SUPPORTED_RUNTIMES = ['runc', 'runsc'];
const TRUSTED_LOCAL_DEV_PROFILES = ['local-dev-execution', 'local-dev-dind'];

/**
 * Validates and parses the Docker daemon connection endpoint.
 *
 * Supported formats:
 * - tcp://host:port (or http://host:port)
 * - unix:///absolute/path/to/socket.sock
 * - npipe:////./pipe/docker_engine (Windows local named pipe)
 *
 * Enforces security boundaries:
 * - Rejects empty/missing DOCKER_HOST unless explicit fallback is enabled.
 * - Rejects direct connection to host /var/run/docker.sock unless explicitly opted in with ALLOW_HOST_DOCKER_SOCKET.
 * - Rejects wildcard (0.0.0.0) or invalid port specifications.
 *
 * @param {string} [dockerHostInput] - Endpoint string (defaults to process.env.DOCKER_HOST)
 * @param {Object} [options]
 * @param {boolean} [options.allowFallback] - Permit local development fallback
 * @param {boolean} [options.allowHostSocket] - Permit host socket override (local dev only)
 * @returns {Object} Dockerode connection options
 */
function parseDockerConnectionConfig(dockerHostInput, options = {}) {
  const dockerHost = (dockerHostInput !== undefined ? dockerHostInput : process.env.DOCKER_HOST || '').trim();
  const allowFallback = options.allowFallback !== undefined
    ? Boolean(options.allowFallback)
    : (process.env.ALLOW_DEFAULT_DOCKER_FALLBACK === 'true' || (process.env.NODE_ENV === 'test' && process.env.ALLOW_TEST_DOCKER_FALLBACK !== 'false'));
  const allowHostSocket = options.allowHostSocket !== undefined
    ? Boolean(options.allowHostSocket)
    : (process.env.ALLOW_HOST_DOCKER_SOCKET === 'true');

  // Case 1: Missing DOCKER_HOST
  if (!dockerHost) {
    if (allowFallback) {
      // In local dev/test with explicit opt-in, use default Dockerode discovery
      if (process.platform === 'win32') {
        return { socketPath: '//./pipe/docker_engine' };
      }
      return { socketPath: '/var/run/docker.sock' };
    }

    throw new Error(
      'Execution daemon endpoint is not configured. DOCKER_HOST must be set to an isolated rootless execution daemon endpoint ' +
      '(e.g., tcp://execution-daemon:2375 or unix:///run/user/<uid>/docker.sock). ' +
      'Implicit fallback to the privileged host Docker daemon is disabled.'
    );
  }

  // Case 2: TCP / HTTP endpoint
  if (/^(tcp|http|https):\/\//i.test(dockerHost)) {
    // Normalise protocol for URL parsing
    const urlString = dockerHost.replace(/^tcp:\/\//i, 'http://');
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (_) {
      throw new Error(`Invalid DOCKER_HOST TCP endpoint: "${dockerHost}". Must be a valid URL (e.g. tcp://execution-daemon:2375).`);
    }

    const hostname = parsed.hostname;
    if (!hostname || hostname === '0.0.0.0') {
      throw new Error(`Invalid DOCKER_HOST hostname: "${hostname}". Wildcard addresses (0.0.0.0) are not permitted.`);
    }

    const port = parseInt(parsed.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid DOCKER_HOST port: "${parsed.port}". Must be a valid port number between 1 and 65535.`);
    }

    return {
      host: hostname,
      port,
      protocol: parsed.protocol === 'https:' ? 'https' : 'http',
    };
  }

  // Case 3: Unix domain socket
  if (/^unix:\/\//i.test(dockerHost)) {
    const rawPath = dockerHost.replace(/^unix:\/\//i, '');
    if (!rawPath || !path.isAbsolute(rawPath)) {
      throw new Error(`Invalid DOCKER_HOST unix socket: "${dockerHost}". Must specify an absolute path (e.g. unix:///run/user/1001/docker.sock).`);
    }

    // Normalize path using forward slashes for cross-platform comparison
    const normalizedPosix = rawPath.replace(/\\/g, '/').replace(/\/+/g, '/');

    // Enforce host socket protection
    if ((normalizedPosix === '/var/run/docker.sock' || normalizedPosix === '/run/docker.sock') && !allowHostSocket) {
      throw new Error(
        `Direct connection to host Docker socket "${normalizedPosix}" is blocked. ` +
        'An unprivileged rootless daemon endpoint (e.g. unix:///run/user/<uid>/docker.sock or tcp://...) is required. ' +
        'Set ALLOW_HOST_DOCKER_SOCKET=true only for trusted single-dev debugging.'
      );
    }

    return { socketPath: path.normalize(rawPath) };
  }

  // Case 4: Windows named pipe (npipe:////./pipe/docker_engine)
  if (/^npipe:\/\//i.test(dockerHost)) {
    const rawPipe = dockerHost.replace(/^npipe:\/\//i, '');
    if (!/^(\/\/|\.\/|\/)\.?\/pipe\//i.test(rawPipe) && !/^\\\\(\.|\?)\\pipe\\/i.test(rawPipe)) {
      throw new Error(`Invalid DOCKER_HOST named pipe: "${dockerHost}". Must match named pipe syntax (e.g. npipe:////./pipe/docker_engine).`);
    }

    return { socketPath: rawPipe };
  }

  throw new Error(
    `Unsupported DOCKER_HOST endpoint format: "${dockerHost}". ` +
    'Expected tcp://host:port, unix:///path/to/socket, or npipe:////./pipe/name.'
  );
}

/**
 * Validates the requested container runtime name.
 *
 * @param {string} [runtimeInput] - Runtime name ('runc', 'runsc', or empty)
 * @returns {string} Normalized runtime name ('runc' or 'runsc')
 */
function validateRuntime(runtimeInput) {
  const runtime = (runtimeInput || '').toLowerCase().trim();
  if (!runtime || runtime === 'runc') {
    return 'runc';
  }
  if (runtime === 'runsc') {
    return 'runsc';
  }

  throw new Error(
    `Unsupported CONTAINER_RUNTIME: "${runtimeInput}". Supported runtimes: ${SUPPORTED_RUNTIMES.join(', ')}.`
  );
}

/**
 * Verifies that the requested runtime is registered in the Docker daemon.
 * Does NOT silently downgrade to runc if runsc is missing.
 *
 * @param {Object} dockerClient - Dockerode client instance
 * @param {string} runtime - Desired runtime ('runsc')
 * @returns {Promise<boolean>} True if registered, throws otherwise
 */
async function verifyRuntimeAvailable(dockerClient, runtime) {
  if (!runtime || runtime === 'runc') {
    return true;
  }

  let info;
  try {
    info = await dockerClient.info();
  } catch (err) {
    throw new Error(`Failed to query execution daemon for runtime capabilities: ${err.message}`);
  }

  const runtimes = info?.Runtimes || {};
  if (!runtimes[runtime]) {
    const available = Object.keys(runtimes).join(', ') || 'none';
    throw new Error(
      `Requested CONTAINER_RUNTIME '${runtime}' (gVisor) is not registered in the execution daemon. ` +
      `Available runtimes on daemon: [${available}]. ` +
      'Please install and register gVisor (runsc) in daemon.json, or configure a supported runtime.'
    );
  }

  return true;
}

/**
 * Verifies whether the connected Docker daemon has genuine cgroup controller enforcement.
 *
 * Inspects:
 * - CgroupDriver: must not be 'none'.
 * - MemoryLimit: kernel memory controller (OOM killer) active.
 * - CPUShares: relative CPU weight scheduling — a necessary condition but NOT sufficient
 *   to enforce the hard per-container 0.5-CPU cap.
 * - CpuCfsQuota / CpuCfsPeriod: kernel CFS bandwidth controller — required for NanoCPUs
 *   (the hard 0.5-CPU quota, i.e. cpu.max in cgroup v2) to actually be enforced.
 *   A daemon reporting CPUShares: true but CpuCfsQuota: false cannot cap the runner's CPU.
 * - PidsLimit: kernel PID controller (fork bomb protection).
 * - Warnings: daemon-level rootless cgroup delegation warnings.
 *
 * NOTE: Even when all flags are true, these are capability advertisements from the daemon
 * process, not live kernel probes. For a production target the host-level controller
 * availability must be independently verified (e.g. `cat /sys/fs/cgroup/cgroup.controllers`,
 * `systemctl --user status docker`). These flags are necessary but not sufficient proof
 * of live enforcement on any specific deployment target.
 *
 * PRODUCTION SAFETY: ALLOW_UNENFORCED_CGROUPS=true is explicitly REJECTED in production.
 * It is a development-only escape hatch for local bounded DinD workflows and must
 * never appear in production environment configuration.
 *
 * @param {Object} dockerClient - Dockerode client instance
 * @param {Object} [options]
 * @param {boolean} [options.requireCgroups] - Whether to strictly fail closed
 * @returns {Promise<{
 *   cgroupDriver: string,
 *   cgroupVersion: string,
 *   memoryLimit: boolean,
 *   cpuShares: boolean,
 *   cpuCfsQuota: boolean,
 *   cpuCfsPeriod: boolean,
 *   pidsLimit: boolean,
 *   controllersEnforced: boolean,
 *   warnings: string[]
 * }>}
 */
async function verifyCgroupCapabilities(dockerClient, options = {}) {
  let info;
  try {
    info = await dockerClient.info();
  } catch (err) {
    throw new Error(`Failed to query execution daemon for cgroup capabilities: ${err.message}`);
  }

  const cgroupDriver = (info?.CgroupDriver || 'none').trim();
  const cgroupVersion = info?.CgroupVersion || 'unknown';
  const memoryLimit = Boolean(info?.MemoryLimit);
  const cpuShares = Boolean(info?.CPUShares);
  // CpuCfsQuota and CpuCfsPeriod are required for the hard 0.5-CPU cap (NanoCPUs) to be
  // enforced at the kernel level. CPUShares alone only provides relative scheduling weight.
  const cpuCfsQuota = Boolean(info?.CpuCfsQuota);
  const cpuCfsPeriod = Boolean(info?.CpuCfsPeriod);
  const pidsLimit = Boolean(info?.PidsLimit);
  const warnings = Array.isArray(info?.Warnings) ? info.Warnings : [];

  const hasCgroupWarning = warnings.some((w) =>
    typeof w === 'string' && /running in rootless-mode without cgroups/i.test(w)
  );

  // All six capabilities must be present for full per-runner kernel enforcement:
  // memory OOM kill, CPU weight scheduling, CPU hard quota (CFS), CPU period, and PID fork limit.
  const controllersEnforced = (
    cgroupDriver !== 'none' &&
    cgroupDriver !== '' &&
    memoryLimit &&
    cpuShares &&
    cpuCfsQuota &&
    cpuCfsPeriod &&
    pidsLimit &&
    !hasCgroupWarning
  );

  // SECURITY: ALLOW_UNENFORCED_CGROUPS is accepted ONLY when the process is explicitly
  // configured for the trusted local-development profile (EXECUTION_PROFILE=local-dev-execution
  // or local-dev-dind) under NODE_ENV=development or test.
  // It is strictly REJECTED for production, staging, untrusted execution, unknown modes,
  // and development without an explicit local-dev profile. NODE_ENV=development alone is NOT trusted.
  const nodeEnv = (options.nodeEnv !== undefined ? options.nodeEnv : process.env.NODE_ENV || '').trim().toLowerCase();
  const executionProfile = (options.executionProfile !== undefined ? options.executionProfile : process.env.EXECUTION_PROFILE || '').trim().toLowerCase();
  const allowUnenforcedOverride = options.allowUnenforcedCgroups !== undefined
    ? Boolean(options.allowUnenforcedCgroups)
    : process.env.ALLOW_UNENFORCED_CGROUPS === 'true';

  const isTrustedLocalDevProfile = (
    (nodeEnv === 'development' || nodeEnv === 'test') &&
    TRUSTED_LOCAL_DEV_PROFILES.includes(executionProfile)
  );

  if (allowUnenforcedOverride && !isTrustedLocalDevProfile) {
    const reason = !TRUSTED_LOCAL_DEV_PROFILES.includes(executionProfile)
      ? `EXECUTION_PROFILE must be explicitly set to a trusted local-development profile (${TRUSTED_LOCAL_DEV_PROFILES.join(', ')}). Received: "${executionProfile || 'unspecified'}"`
      : `NODE_ENV must be "development" or "test". Received: "${nodeEnv || 'unspecified'}"`;

    throw new Error(
      `ALLOW_UNENFORCED_CGROUPS=true is not permitted in deployment mode "${nodeEnv || 'unspecified'}" ` +
      `(EXECUTION_PROFILE: "${executionProfile || 'unspecified'}"). ` +
      `This exception is reserved exclusively for the trusted local-development profile ` +
      `(EXECUTION_PROFILE=local-dev-execution under NODE_ENV=development or test). ` +
      `Reason: ${reason}. ` +
      `Un-enforced cgroups are strictly rejected for production, staging, untrusted execution, and unknown deployment modes.`
    );
  }

  // Resolve whether enforcement is required for this invocation.
  let requireCgroups;
  if (options.requireCgroups !== undefined) {
    requireCgroups = Boolean(options.requireCgroups);
  } else if (
    process.env.REQUIRE_CGROUP_ENFORCEMENT === 'true' ||
    process.env.REQUIRE_CGROUP_ENFORCEMENT === '1'
  ) {
    requireCgroups = true;
  } else if (
    process.env.REQUIRE_CGROUP_ENFORCEMENT === 'false' ||
    process.env.REQUIRE_CGROUP_ENFORCEMENT === '0'
  ) {
    // Explicit disable is only permitted in the trusted local-dev profile
    if (!isTrustedLocalDevProfile) {
      throw new Error(
        `REQUIRE_CGROUP_ENFORCEMENT=false is not permitted in deployment mode "${nodeEnv || 'unspecified'}" ` +
        `(EXECUTION_PROFILE: "${executionProfile || 'unspecified'}"). ` +
        `Cgroup enforcement can only be disabled under the trusted local-development profile ` +
        `(EXECUTION_PROFILE=local-dev-execution under NODE_ENV=development or test).`
      );
    }
    requireCgroups = false;
  } else {
    // Default: fail-closed (require cgroups) unless running under trusted local-dev profile
    requireCgroups = !isTrustedLocalDevProfile;
  }

  if (!requireCgroups && !isTrustedLocalDevProfile) {
    throw new Error('REQUIRE_CGROUP_ENFORCEMENT=false is not permitted outside the trusted local-development profile.');
  }

  if (requireCgroups && !controllersEnforced) {
    const missingControllers = [];
    if (!memoryLimit) missingControllers.push('memory limit');
    if (!cpuShares) missingControllers.push('CPU shares (relative weight)');
    if (!cpuCfsQuota) missingControllers.push('CPU CFS quota (hard 0.5-CPU cap, NanoCPUs)');
    if (!cpuCfsPeriod) missingControllers.push('CPU CFS period');
    if (!pidsLimit) missingControllers.push('PID limit');
    if (cgroupDriver === 'none' || cgroupDriver === '') missingControllers.push('cgroup driver (reported: none)');
    if (hasCgroupWarning) missingControllers.push('rootless cgroups disabled by host');

    throw new Error(
      `Execution daemon cgroup enforcement is required, but daemon does not enforce kernel resource limits. ` +
      `Cgroup driver: "${cgroupDriver}", missing/disabled: [${missingControllers.join(', ')}]. ` +
      `Per-runner CPU (NanoCPUs hard quota requires CpuCfsQuota+CpuCfsPeriod), memory OOM kill, ` +
      `and PID fork limits cannot be enforced at the kernel level in this configuration. ` +
      `A host-level rootless Docker daemon under systemd with cgroup v2 controller delegation ` +
      `(Delegate=cpu cpuset io memory pids) is required for production untrusted-code execution.`
    );
  }

  return {
    cgroupDriver,
    cgroupVersion,
    memoryLimit,
    cpuShares,
    cpuCfsQuota,
    cpuCfsPeriod,
    pidsLimit,
    controllersEnforced,
    warnings,
  };
}


module.exports = {
  parseDockerConnectionConfig,
  validateRuntime,
  verifyRuntimeAvailable,
  verifyCgroupCapabilities,
  SUPPORTED_RUNTIMES,
  TRUSTED_LOCAL_DEV_PROFILES,
};
