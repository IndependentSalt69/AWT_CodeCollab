/**
 * CodeCollab M1.1 — Environment & Capability Probe
 *
 * Inspects host OS, WSL2 virtualization, cgroup v2 controller availability,
 * and Docker daemon capability advertisements without making assumptions.
 */

const os = require('os');
const fs = require('fs');
const { verifyCgroupCapabilities } = require('../execution/engine/dockerConfig');

/**
 * Detects the host operating system, kernel, distribution, and WSL status.
 *
 * @param {Object} [overrides] - Test-only dependency injection
 * @returns {Object} Detected environment attributes
 */
function detectHostEnvironment(overrides = {}) {
  const platform = overrides.platform || process.platform;
  const arch = overrides.arch || process.arch;
  const kernelRelease = overrides.kernelRelease || os.release();

  let isWsl = false;
  let distribution = platform;
  let cgroupV2Controllers = [];
  let userControllers = [];

  // Check /proc/version if present (Linux / WSL)
  const procVersionPath = overrides.procVersionPath || '/proc/version';
  if (fs.existsSync(procVersionPath)) {
    try {
      const procContent = fs.readFileSync(procVersionPath, 'utf8');
      if (/microsoft|wsl/i.test(procContent) || /microsoft|wsl/i.test(kernelRelease)) {
        isWsl = true;
      }
    } catch (_) {}
  } else if (/microsoft|wsl/i.test(kernelRelease)) {
    isWsl = true;
  }

  // Parse /etc/os-release if present
  const osReleasePath = overrides.osReleasePath || '/etc/os-release';
  if (fs.existsSync(osReleasePath)) {
    try {
      const content = fs.readFileSync(osReleasePath, 'utf8');
      const prettyMatch = content.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
      const nameMatch = content.match(/^NAME="?([^"\n]+)"?/m);
      distribution = prettyMatch ? prettyMatch[1] : (nameMatch ? nameMatch[1] : platform);
    } catch (_) {}
  }

  // Inspect /sys/fs/cgroup/cgroup.controllers if present
  const cgroupControllersPath = overrides.cgroupControllersPath || '/sys/fs/cgroup/cgroup.controllers';
  if (fs.existsSync(cgroupControllersPath)) {
    try {
      const raw = fs.readFileSync(cgroupControllersPath, 'utf8').trim();
      cgroupV2Controllers = raw ? raw.split(/\s+/) : [];
    } catch (_) {}
  }

  // Inspect user slice controllers if present (e.g. /sys/fs/cgroup/user.slice/cgroup.subtree_control)
  const userSubtreePath = overrides.userSubtreePath || '/sys/fs/cgroup/user.slice/cgroup.subtree_control';
  if (fs.existsSync(userSubtreePath)) {
    try {
      const raw = fs.readFileSync(userSubtreePath, 'utf8').trim();
      userControllers = raw ? raw.split(/\s+/) : [];
    } catch (_) {}
  }

  return {
    platform,
    arch,
    kernelRelease,
    distribution,
    isWsl,
    cgroupV2Available: cgroupV2Controllers.length > 0,
    availableControllers: cgroupV2Controllers,
    userSubtreeControllers: userControllers,
  };
}

/**
 * Queries the connected Docker daemon for capability flags, driver, and runtimes.
 *
 * @param {Object} dockerClient - Dockerode instance
 * @param {Object} [overrides] - Test-only dependency injection
 * @returns {Promise<Object>}
 */
async function probeDockerDaemon(dockerClient, overrides = {}) {
  let info = overrides.info;
  if (!info && dockerClient && typeof dockerClient.info === 'function') {
    try {
      info = await dockerClient.info();
    } catch (err) {
      return {
        connected: false,
        error: err.message,
      };
    }
  }

  if (!info) {
    return {
      connected: false,
      error: 'Docker info unavailable',
    };
  }

  const serverVersion = info.ServerVersion || 'unknown';
  const cgroupDriver = (info.CgroupDriver || 'none').trim();
  const cgroupVersion = info.CgroupVersion || 'unknown';
  const securityOptions = Array.isArray(info.SecurityOptions) ? info.SecurityOptions : [];

  // Determine if daemon is rootless
  const isRootless = securityOptions.some((opt) => typeof opt === 'string' && opt.toLowerCase().includes('rootless')) ||
    (Array.isArray(info.DriverStatus) && info.DriverStatus.some((row) => row && String(row[0]).toLowerCase().includes('rootless')));

  const runtimes = Object.keys(info.Runtimes || {});
  const hasRunsc = runtimes.includes('runsc');

  // Verify cgroup capabilities using project helper
  let cgroupCaps = null;
  try {
    cgroupCaps = await verifyCgroupCapabilities(dockerClient, {
      requireCgroups: false,
      allowUnenforcedCgroups: true,
      executionProfile: 'local-dev-execution',
      nodeEnv: 'development',
    });
  } catch (_) {
    cgroupCaps = {
      controllersEnforced: false,
      cgroupDriver,
      memoryLimit: Boolean(info.MemoryLimit),
      cpuShares: Boolean(info.CPUShares),
      cpuCfsQuota: Boolean(info.CpuCfsQuota),
      cpuCfsPeriod: Boolean(info.CpuCfsPeriod),
      pidsLimit: Boolean(info.PidsLimit),
      warnings: info.Warnings || [],
    };
  }

  return {
    connected: true,
    serverVersion,
    cgroupDriver,
    cgroupVersion,
    isRootless,
    securityOptions,
    memoryLimit: Boolean(info.MemoryLimit),
    cpuShares: Boolean(info.CPUShares),
    cpuCfsQuota: Boolean(info.CpuCfsQuota),
    cpuCfsPeriod: Boolean(info.CpuCfsPeriod),
    pidsLimit: Boolean(info.PidsLimit),
    warnings: Array.isArray(info.Warnings) ? info.Warnings : [],
    runtimes,
    hasRunsc,
    cgroupControllersEnforced: Boolean(cgroupCaps?.controllersEnforced),
  };
}

/**
 * Evaluates whether the current environment is eligible for live stress probes.
 *
 * @param {Object} environment - Output of detectHostEnvironment()
 * @param {Object} daemon - Output of probeDockerDaemon()
 * @param {Object} [options]
 * @param {boolean} [options.strict=false] - If true, requires qualification-eligible environment
 * @param {boolean} [options.allowRootful=false] - Permit probes on rootful daemon (not recommended)
 * @returns {Object} { canRunLiveProbes, skipReason, warnings, strictFailure }
 */
function evaluatePreflight(environment, daemon, options = {}) {
  const strict = Boolean(options.strict);
  const allowRootful = Boolean(options.allowRootful);
  const warnings = [];

  // Case 1: Docker connection failure
  if (!daemon.connected) {
    return {
      canRunLiveProbes: false,
      skipReason: `Docker daemon unreachable: ${daemon.error}`,
      warnings: ['Cannot connect to execution daemon.'],
      strictFailure: strict,
    };
  }

  // Case 2: Windows host detected
  if (environment.platform === 'win32') {
    return {
      canRunLiveProbes: false,
      skipReason: 'Windows host detected. Live cgroup v2 kernel resource-enforcement probes require a systemd-managed Linux environment with rootless Docker.',
      warnings: ['Windows cannot enforce Linux cgroup v2 limits directly. Standard development workflow preserved.'],
      strictFailure: strict,
    };
  }

  // Case 3: CgroupDriver check - M1.1 target requires 'systemd'
  const cgroupDriver = typeof daemon.cgroupDriver === 'string' ? daemon.cgroupDriver.trim().toLowerCase() : '';
  if (cgroupDriver !== 'systemd') {
    return {
      canRunLiveProbes: false,
      skipReason: cgroupDriver === 'none' || !cgroupDriver
        ? 'Docker daemon cgroup driver is "none". Per-container kernel limits are not enforced by the connected daemon.'
        : `Docker daemon cgroup driver is "${daemon.cgroupDriver}". M1.1 resource enforcement requires the systemd cgroup driver.`,
      warnings: [`Connected daemon cgroup driver is "${daemon.cgroupDriver || 'none'}". Run with systemd cgroup driver.`],
      strictFailure: strict,
    };
  }

  // Case 4: Privileged rootful daemon refusal (safety policy)
  if (!daemon.isRootless && !allowRootful) {
    return {
      canRunLiveProbes: false,
      skipReason: 'Connected Docker daemon is rootful (privileged). Live resource-enforcement stress probes are restricted to unprivileged rootless daemons to protect host stability.',
      warnings: ['Rootful daemon detected. Target environment must be an unprivileged rootless Docker daemon under systemd.'],
      strictFailure: strict,
    };
  }

  // Case 5: CgroupVersion check - M1.1 target requires confirmed cgroup v2
  const rawVersion = daemon.cgroupVersion !== undefined && daemon.cgroupVersion !== null
    ? String(daemon.cgroupVersion).trim()
    : '';
  const normalizedVersion = rawVersion.replace(/^v/i, '');

  if (normalizedVersion !== '2') {
    const isMissing = rawVersion === '';
    const displayVersion = isMissing
      ? ''
      : (rawVersion.toLowerCase().startsWith('v') ? rawVersion : `v${rawVersion}`);
    return {
      canRunLiveProbes: false,
      skipReason: isMissing
        ? 'Docker daemon cgroup version is unconfirmed or missing. M1.1 resource enforcement requires verified cgroup v2.'
        : `Docker daemon cgroup version is "${displayVersion}". M1.1 resource enforcement requires cgroup v2.`,
      warnings: [
        isMissing
          ? 'Connected daemon cgroup version could not be confirmed as cgroup v2. Cgroup v2 is required for resource enforcement.'
          : `Connected daemon is running cgroup ${displayVersion}. Cgroup v2 is required for production qualification.`,
      ],
      strictFailure: strict,
    };
  }

  // Case 6: WSL2 environment notice
  if (environment.isWsl) {
    warnings.push('WSL2 environment detected. Live probes demonstrate cgroup v2 mechanics, but WSL2 does not qualify a dedicated Linux production release.');
  }

  return {
    canRunLiveProbes: true,
    skipReason: null,
    warnings,
    strictFailure: false,
  };
}

module.exports = {
  detectHostEnvironment,
  probeDockerDaemon,
  evaluatePreflight,
};
