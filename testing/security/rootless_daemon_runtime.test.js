const fs = require('fs');
const path = require('path');
const Docker = require('dockerode');
const {
  parseDockerConnectionConfig,
  validateRuntime,
  verifyRuntimeAvailable,
  verifyCgroupCapabilities,
  SUPPORTED_RUNTIMES,
  TRUSTED_LOCAL_DEV_PROFILES,
} = require('../../execution/engine/dockerConfig');
const {
  runInSandbox,
  getDockerClient,
  resetDockerClient,
} = require('../../execution/engine/executor');
const {
  validateWorkerPreflight,
  getWorker,
} = require('../../execution/worker/index');
const sandboxConfig = require('../../execution/engine/sandboxConfig');


describe('Rootless Execution Daemon & Runtime Isolation Suite (M1.0 Phase B)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetDockerClient();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    resetDockerClient();
    process.env = { ...originalEnv };
  });

  describe('1. Docker Connection Configuration Parsing & Security Enforcement', () => {
    test('rejects empty DOCKER_HOST when fallback is not permitted (never silently falls back)', () => {
      delete process.env.DOCKER_HOST;
      delete process.env.ALLOW_DEFAULT_DOCKER_FALLBACK;

      expect(() => {
        parseDockerConnectionConfig('', { allowFallback: false });
      }).toThrow(/Execution daemon endpoint is not configured/i);

      expect(() => {
        parseDockerConnectionConfig(undefined, { allowFallback: false });
      }).toThrow(/Implicit fallback to the privileged host Docker daemon is disabled/i);
    });

    test('permits default host socket ONLY when explicit local dev fallback is configured', () => {
      delete process.env.DOCKER_HOST;
      process.env.ALLOW_DEFAULT_DOCKER_FALLBACK = 'true';

      const config = parseDockerConnectionConfig('', { allowFallback: true });
      expect(config).toBeDefined();
      if (process.platform === 'win32') {
        expect(config.socketPath).toBe('//./pipe/docker_engine');
      } else {
        expect(config.socketPath).toBe('/var/run/docker.sock');
      }
    });

    test('blocks direct connection to host /var/run/docker.sock unless explicitly opted in', () => {
      delete process.env.ALLOW_HOST_DOCKER_SOCKET;

      expect(() => {
        parseDockerConnectionConfig('unix:///var/run/docker.sock', { allowHostSocket: false });
      }).toThrow(/Direct connection to host Docker socket.*is blocked/i);

      expect(() => {
        parseDockerConnectionConfig('unix:///run/docker.sock', { allowHostSocket: false });
      }).toThrow(/Direct connection to host Docker socket.*is blocked/i);
    });

    test('allows host /var/run/docker.sock ONLY with explicit allowHostSocket override', () => {
      const config = parseDockerConnectionConfig('unix:///var/run/docker.sock', { allowHostSocket: true });
      expect(config).toEqual({ socketPath: path.normalize('/var/run/docker.sock') });
    });

    test('accepts dedicated unprivileged rootless host user sockets', () => {
      const rootlessSocket = 'unix:///run/user/1000/docker.sock';
      const config = parseDockerConnectionConfig(rootlessSocket);
      expect(config).toEqual({ socketPath: path.normalize('/run/user/1000/docker.sock') });

      const customUserSocket = 'unix:///run/user/1001/codecollab-docker.sock';
      const config2 = parseDockerConnectionConfig(customUserSocket);
      expect(config2).toEqual({ socketPath: path.normalize('/run/user/1001/codecollab-docker.sock') });
    });

    test('rejects relative or malformed unix socket paths', () => {
      expect(() => {
        parseDockerConnectionConfig('unix://relative/socket.sock');
      }).toThrow(/Invalid DOCKER_HOST unix socket/i);

      expect(() => {
        parseDockerConnectionConfig('unix://');
      }).toThrow(/Invalid DOCKER_HOST unix socket/i);
    });

    test('parses valid TCP daemon endpoints for internal networks', () => {
      const config = parseDockerConnectionConfig('tcp://execution-daemon:2375');
      expect(config).toEqual({
        host: 'execution-daemon',
        port: 2375,
        protocol: 'http',
      });

      const configHttp = parseDockerConnectionConfig('http://10.0.1.5:2375');
      expect(configHttp).toEqual({
        host: '10.0.1.5',
        port: 2375,
        protocol: 'http',
      });

      const configTls = parseDockerConnectionConfig('https://secure-daemon.internal:2376');
      expect(configTls).toEqual({
        host: 'secure-daemon.internal',
        port: 2376,
        protocol: 'https',
      });
    });

    test('rejects wildcard (0.0.0.0) TCP endpoints and invalid ports', () => {
      expect(() => {
        parseDockerConnectionConfig('tcp://0.0.0.0:2375');
      }).toThrow(/Wildcard addresses \(0\.0\.0\.0\) are not permitted/i);

      expect(() => {
        parseDockerConnectionConfig('tcp://execution-daemon:invalid-port');
      }).toThrow(/Invalid DOCKER_HOST (port|TCP endpoint)/i);

      expect(() => {
        parseDockerConnectionConfig('tcp://execution-daemon:0');
      }).toThrow(/Must be a valid port number between 1 and 65535/i);

      expect(() => {
        parseDockerConnectionConfig('tcp://execution-daemon:70000');
      }).toThrow(/Invalid DOCKER_HOST (port|TCP endpoint)/i);
    });

    test('parses Windows named pipe endpoints and rejects malformed pipes', () => {
      const config = parseDockerConnectionConfig('npipe:////./pipe/docker_engine');
      expect(config).toEqual({ socketPath: '//./pipe/docker_engine' });

      expect(() => {
        parseDockerConnectionConfig('npipe://invalid_pipe_name');
      }).toThrow(/Invalid DOCKER_HOST named pipe/i);
    });

    test('rejects unsupported URI schemes', () => {
      expect(() => {
        parseDockerConnectionConfig('ftp://execution-daemon:21');
      }).toThrow(/Unsupported DOCKER_HOST endpoint format/i);

      expect(() => {
        parseDockerConnectionConfig('ssh://user@remote-host');
      }).toThrow(/Unsupported DOCKER_HOST endpoint format/i);
    });
  });

  describe('2. Container Runtime Validation & gVisor Detection', () => {
    test('validateRuntime normalizes supported runtimes and defaults to runc', () => {
      expect(validateRuntime('')).toBe('runc');
      expect(validateRuntime(undefined)).toBe('runc');
      expect(validateRuntime('runc')).toBe('runc');
      expect(validateRuntime('RUNC')).toBe('runc');
      expect(validateRuntime('runsc')).toBe('runsc');
      expect(validateRuntime('RUNSC')).toBe('runsc');
    });

    test('validateRuntime rejects unsupported container runtimes with clear error', () => {
      expect(() => validateRuntime('kata')).toThrow(/Unsupported CONTAINER_RUNTIME: "kata"/i);
      expect(() => validateRuntime('crun')).toThrow(/Unsupported CONTAINER_RUNTIME: "crun"/i);
      expect(() => validateRuntime('firecracker')).toThrow(/Unsupported CONTAINER_RUNTIME: "firecracker"/i);
    });

    test('verifyRuntimeAvailable immediately accepts runc without querying daemon', async () => {
      const mockClient = { info: jest.fn() };
      const result = await verifyRuntimeAvailable(mockClient, 'runc');
      expect(result).toBe(true);
      expect(mockClient.info).not.toHaveBeenCalled();
    });

    test('verifyRuntimeAvailable accepts runsc when registered in daemon info', async () => {
      const mockClient = {
        info: jest.fn().mockResolvedValue({
          Runtimes: {
            runc: { path: 'runc' },
            runsc: { path: '/usr/local/bin/runsc' },
          },
        }),
      };

      const result = await verifyRuntimeAvailable(mockClient, 'runsc');
      expect(result).toBe(true);
      expect(mockClient.info).toHaveBeenCalledTimes(1);
    });

    test('verifyRuntimeAvailable fails with actionable error and NEVER silently downgrades when runsc is missing', async () => {
      const mockClient = {
        info: jest.fn().mockResolvedValue({
          Runtimes: {
            runc: { path: 'runc' },
            nvidia: { path: 'nvidia-container-runtime' },
          },
        }),
      };

      await expect(verifyRuntimeAvailable(mockClient, 'runsc')).rejects.toThrow(
        /Requested CONTAINER_RUNTIME 'runsc' \(gVisor\) is not registered in the execution daemon.*Available runtimes on daemon: \[runc, nvidia\]/i
      );
    });

    test('verifyRuntimeAvailable propagates daemon query errors clearly', async () => {
      const mockClient = {
        info: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:2375')),
      };

      await expect(verifyRuntimeAvailable(mockClient, 'runsc')).rejects.toThrow(
        /Failed to query execution daemon for runtime capabilities: connect ECONNREFUSED/i
      );
    });
  });

  describe('3. Dockerode Client Factory & Singleton Management', () => {
    test('getDockerClient uses parsed options from custom configuration', () => {
      const client = getDockerClient('tcp://execution-daemon:2375');
      expect(client).toBeDefined();
      expect(client.modem.host).toBe('execution-daemon');
      expect(client.modem.port).toBe(2375);
    });

    test('getDockerClient caches singleton instance when called without arguments', () => {
      process.env.DOCKER_HOST = 'tcp://execution-daemon:2375';
      const client1 = getDockerClient();
      const client2 = getDockerClient();
      expect(client1).toBe(client2);

      resetDockerClient();
      const client3 = getDockerClient();
      expect(client3).not.toBe(client1);
    });
  });

  describe('4. Runner Container Security Configuration & Socket Non-Mounting', () => {
    test('creates container with all M0.9 security bounds and ZERO socket mounts', async () => {
      const mockContainer = {
        attach: jest.fn().mockResolvedValue({
          on: jest.fn(),
          pipe: jest.fn(),
        }),
        start: jest.fn().mockResolvedValue(),
        wait: jest.fn().mockResolvedValue({ StatusCode: 0 }),
        remove: jest.fn().mockResolvedValue(),
      };

      let capturedCreateOptions = null;
      const mockDocker = {
        createContainer: jest.fn().mockImplementation(async (opts) => {
          capturedCreateOptions = opts;
          return mockContainer;
        }),
        modem: {
          demuxStream: jest.fn(),
        },
      };

      jest.spyOn(Docker.prototype, 'createContainer').mockImplementation(async (opts) => {
        capturedCreateOptions = opts;
        return mockContainer;
      });

      // Run code in sandbox with mocked docker
      process.env.ALLOW_DEFAULT_DOCKER_FALLBACK = 'true';
      const result = await runInSandbox({
        language: 'python',
        code: 'print("Security verification")',
        timeout: 5000,
        memory: '256m',
      });

      expect(capturedCreateOptions).toBeDefined();
      const hostConfig = capturedCreateOptions.HostConfig;

      // Assert all M0.9 isolation bounds
      expect(hostConfig.ReadonlyRootfs).toBe(true);
      expect(hostConfig.CapDrop).toEqual(['ALL']);
      expect(hostConfig.SecurityOpt).toEqual(['no-new-privileges:true']);
      expect(hostConfig.NetworkMode).toBe('none');
      expect(hostConfig.PidsLimit).toBe(64);
      expect(hostConfig.Memory).toBe(256 * 1024 * 1024);
      expect(hostConfig.MemorySwap).toBe(256 * 1024 * 1024);
      expect(hostConfig.NanoCPUs).toBe(500000000);
      expect(hostConfig.Tmpfs).toEqual({ '/tmp': 'rw,noexec,nosuid,size=32m' });

      // CRITICAL: Ensure NO host Docker socket or daemon credential is mounted into user container
      expect(hostConfig.Binds).toBeUndefined();
      expect(capturedCreateOptions.Volumes).toBeUndefined();

      // Verify limits report contains runtime
      expect(result.limits.runtime).toBe('runc');

      Docker.prototype.createContainer.mockRestore();
    });

    test('passes Runtime: "runsc" in HostConfig when gVisor is configured and verified', async () => {
      const mockContainer = {
        attach: jest.fn().mockResolvedValue({ on: jest.fn(), pipe: jest.fn() }),
        start: jest.fn().mockResolvedValue(),
        wait: jest.fn().mockResolvedValue({ StatusCode: 0 }),
        remove: jest.fn().mockResolvedValue(),
      };

      let capturedCreateOptions = null;
      jest.spyOn(Docker.prototype, 'createContainer').mockImplementation(async (opts) => {
        capturedCreateOptions = opts;
        return mockContainer;
      });

      jest.spyOn(Docker.prototype, 'info').mockResolvedValue({
        Runtimes: {
          runc: {},
          runsc: { path: '/usr/local/bin/runsc' },
        },
      });

      process.env.ALLOW_DEFAULT_DOCKER_FALLBACK = 'true';
      const result = await runInSandbox({
        language: 'python',
        code: 'print("gVisor verification")',
        runtime: 'runsc',
      });

      expect(capturedCreateOptions).toBeDefined();
      expect(capturedCreateOptions.HostConfig.Runtime).toBe('runsc');
      expect(result.limits.runtime).toBe('runsc');

      Docker.prototype.createContainer.mockRestore();
      Docker.prototype.info.mockRestore();
    });
  });

  describe('5. Docker Compose Network Boundaries Verification', () => {
    test('docker-compose.yml strictly isolates backend, worker, and execution daemon', () => {
      const composePath = path.resolve(__dirname, '../../infrastructure/docker-compose.yml');
      const composeContent = fs.readFileSync(composePath, 'utf8');

      // 1. Verify networks definition contains internal execution-network
      expect(composeContent).toMatch(/execution-network:\s*\n\s*driver:\s*bridge\s*\n\s*internal:\s*true/);
      expect(composeContent).toMatch(/app-network:\s*\n\s*driver:\s*bridge/);

      // 2. Verify backend is attached to app-network ONLY
      const backendSection = composeContent.match(/backend:[\s\S]*?(?=frontend:)/)?.[0] || '';
      expect(backendSection).toContain('app-network');
      expect(backendSection).not.toContain('execution-network');
      expect(backendSection).not.toContain('DOCKER_HOST');
      expect(backendSection).not.toContain('docker.sock');

      // 3. Verify execution-daemon is attached to execution-network ONLY (NOT app-network)
      const daemonSection = composeContent.match(/execution-daemon:\s*\n[\s\S]*?(?=# SEC-INFRA-02|execution-worker:)/)?.[0] || '';
      expect(daemonSection).toContain('execution-network');
      expect(daemonSection).not.toContain('app-network');
      expect(daemonSection).not.toMatch(/ports:\s*\n\s*-\s*["']?\d+/); // Zero published ports

      // 4. Verify execution-worker does NOT mount the host docker socket
      const workerSection = composeContent.match(/execution-worker:\s*\n[\s\S]*?(?=\nnetworks:)/)?.[0] || '';
      expect(workerSection).not.toContain('/var/run/docker.sock:/var/run/docker.sock');
      expect(workerSection).toContain('DOCKER_HOST=tcp://execution-daemon:2375');
      expect(workerSection).toContain('app-network');
      expect(workerSection).toContain('execution-network');
    });
  });

  describe('6. Real Host Daemon Capability Probe & Safe Failure (Live Probe)', () => {
    test('probes live local engine and fails safely without downgrade if runsc is absent', async () => {
      process.env.ALLOW_DEFAULT_DOCKER_FALLBACK = 'true';
      const liveDocker = getDockerClient();

      let info;
      try {
        info = await liveDocker.info();
      } catch (err) {
        // If docker daemon is not accessible, skip live probe
        return;
      }

      const availableRuntimes = Object.keys(info?.Runtimes || {});
      const hasRunsc = availableRuntimes.includes('runsc');

      if (!hasRunsc) {
        // On hosts without gVisor (like standard Docker Desktop on Windows),
        // verify that requesting runsc fails with an explicit error and does NOT silently run on runc.
        await expect(
          runInSandbox({
            language: 'python',
            code: 'print("Testing runsc failure")',
            runtime: 'runsc',
          })
        ).rejects.toThrow(/Requested CONTAINER_RUNTIME 'runsc' \(gVisor\) is not registered/i);
      } else {
        // Host has runsc installed: verify it executes with runsc
        const result = await runInSandbox({
          language: 'python',
          code: 'print("Live runsc execution")',
          runtime: 'runsc',
        });
        expect(result.status).toBe('completed');
        expect(result.limits.runtime).toBe('runsc');
      }
    });
  });

  describe('7. Daemon Cgroup Capabilities & Fail-Closed Enforcement', () => {
    test('detects CgroupDriver: none and returns controllersEnforced: false when not required', async () => {
      const mockClient = {
        info: async () => ({
          CgroupDriver: 'none',
          CgroupVersion: '2',
          MemoryLimit: false,
          CPUShares: false,
          CpuCfsQuota: false,
          CpuCfsPeriod: false,
          PidsLimit: false,
        }),
      };
      const caps = await verifyCgroupCapabilities(mockClient, { requireCgroups: false, nodeEnv: 'test', executionProfile: 'local-dev-execution' });
      expect(caps.cgroupDriver).toBe('none');
      expect(caps.controllersEnforced).toBe(false);
      expect(caps.memoryLimit).toBe(false);
      expect(caps.cpuCfsQuota).toBe(false);
      expect(caps.cpuCfsPeriod).toBe(false);
      expect(caps.pidsLimit).toBe(false);
    });

    test('fails closed with explicit error when cgroup enforcement is required but driver is none', async () => {
      const mockClient = {
        info: async () => ({
          CgroupDriver: 'none',
          CgroupVersion: '2',
          MemoryLimit: false,
          CPUShares: false,
          CpuCfsQuota: false,
          CpuCfsPeriod: false,
          PidsLimit: false,
        }),
      };
      await expect(
        verifyCgroupCapabilities(mockClient, { requireCgroups: true })
      ).rejects.toThrow(/Execution daemon cgroup enforcement is required, but daemon does not enforce kernel resource limits/i);
    });

    test('fails closed if CgroupDriver is set but memory or PID controller is disabled', async () => {
      const mockClientPartial = {
        info: async () => ({
          CgroupDriver: 'systemd',
          CgroupVersion: '2',
          MemoryLimit: false, // Memory controller disabled on host
          CPUShares: true,
          CpuCfsQuota: true,
          CpuCfsPeriod: true,
          PidsLimit: true,
        }),
      };
      await expect(
        verifyCgroupCapabilities(mockClientPartial, { requireCgroups: true })
      ).rejects.toThrow(/missing\/disabled: \[memory limit\]/i);
    });

    test('fails closed if CPUShares is true but CpuCfsQuota is false — hard 0.5-CPU cap cannot be enforced', async () => {
      // This is the key regression: CPUShares=true only means relative weight scheduling is available.
      // It does NOT prove that the hard NanoCPUs quota (cpu.max via CFS) is enforced.
      // A daemon that reports CPUShares: true but CpuCfsQuota: false will SILENTLY ignore --cpus=0.5.
      const mockClientCpuSharesOnlyNoCfsQuota = {
        info: async () => ({
          CgroupDriver: 'systemd',
          CgroupVersion: '2',
          MemoryLimit: true,
          CPUShares: true,       // Relative weight only — NOT a hard quota
          CpuCfsQuota: false,    // Hard CFS quota controller ABSENT — NanoCPUs not enforced
          CpuCfsPeriod: true,
          PidsLimit: true,
        }),
      };

      await expect(
        verifyCgroupCapabilities(mockClientCpuSharesOnlyNoCfsQuota, { requireCgroups: true })
      ).rejects.toThrow(/CPU CFS quota \(hard 0\.5-CPU cap, NanoCPUs\)/i);
    });

    test('fails closed if CpuCfsPeriod is false even when CpuCfsQuota is true', async () => {
      const mockClientNoPeriod = {
        info: async () => ({
          CgroupDriver: 'systemd',
          CgroupVersion: '2',
          MemoryLimit: true,
          CPUShares: true,
          CpuCfsQuota: true,
          CpuCfsPeriod: false,  // Period ABSENT — quota without period is inoperable
          PidsLimit: true,
        }),
      };

      await expect(
        verifyCgroupCapabilities(mockClientNoPeriod, { requireCgroups: true })
      ).rejects.toThrow(/CPU CFS period/i);
    });

    test('fails closed if daemon warnings indicate rootless-mode without cgroups', async () => {
      const mockClientWithWarning = {
        info: async () => ({
          CgroupDriver: 'systemd',
          CgroupVersion: '2',
          MemoryLimit: true,
          CPUShares: true,
          CpuCfsQuota: true,
          CpuCfsPeriod: true,
          PidsLimit: true,
          Warnings: ['WARNING: Running in rootless-mode without cgroups. Systemd is required to enable cgroups in rootless-mode.'],
        }),
      };
      await expect(
        verifyCgroupCapabilities(mockClientWithWarning, { requireCgroups: true })
      ).rejects.toThrow(/rootless cgroups disabled by host/i);
    });

    test('automatically defaults to fail-closed when NODE_ENV is production', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.REQUIRE_CGROUP_ENFORCEMENT;
      delete process.env.ALLOW_UNENFORCED_CGROUPS;

      const mockClientDinD = {
        info: async () => ({
          CgroupDriver: 'none',
          CgroupVersion: '2',
          MemoryLimit: false,
          CPUShares: false,
          CpuCfsQuota: false,
          CpuCfsPeriod: false,
          PidsLimit: false,
        }),
      };

      await expect(
        verifyCgroupCapabilities(mockClientDinD)
      ).rejects.toThrow(/Execution daemon cgroup enforcement is required/i);
    });

    test('PRODUCTION: ALLOW_UNENFORCED_CGROUPS=true is explicitly rejected — cannot bypass gate even when both env vars are set', async () => {
      process.env.NODE_ENV = 'production';
      process.env.ALLOW_UNENFORCED_CGROUPS = 'true';
      process.env.REQUIRE_CGROUP_ENFORCEMENT = 'false';

      const mockClientDinD = {
        info: async () => ({
          CgroupDriver: 'none',
          CgroupVersion: '2',
          MemoryLimit: false,
          CPUShares: false,
          CpuCfsQuota: false,
          CpuCfsPeriod: false,
          PidsLimit: false,
        }),
      };

      await expect(
        verifyCgroupCapabilities(mockClientDinD)
      ).rejects.toThrow(/ALLOW_UNENFORCED_CGROUPS=true is not permitted in deployment mode "production"/i);
    });

    test('STAGING: ALLOW_UNENFORCED_CGROUPS=true is strictly rejected — non-production staging environments cannot disable enforcement', async () => {
      process.env.NODE_ENV = 'staging';
      process.env.ALLOW_UNENFORCED_CGROUPS = 'true';
      process.env.EXECUTION_PROFILE = 'local-dev-execution'; // Even with profile, staging cannot bypass!

      const mockClientDinD = {
        info: async () => ({
          CgroupDriver: 'none',
          CgroupVersion: '2',
          MemoryLimit: false,
          CPUShares: false,
          CpuCfsQuota: false,
          CpuCfsPeriod: false,
          PidsLimit: false,
        }),
      };

      await expect(
        verifyCgroupCapabilities(mockClientDinD)
      ).rejects.toThrow(/ALLOW_UNENFORCED_CGROUPS=true is not permitted in deployment mode "staging"/i);
    });

    test('UNKNOWN DEPLOYMENT MODE: ALLOW_UNENFORCED_CGROUPS=true is strictly rejected when NODE_ENV is unknown or custom', async () => {
      process.env.NODE_ENV = 'custom-cloud-mode';
      process.env.ALLOW_UNENFORCED_CGROUPS = 'true';

      const mockClientDinD = {
        info: async () => ({
          CgroupDriver: 'none',
          CgroupVersion: '2',
          MemoryLimit: false,
          CPUShares: false,
          CpuCfsQuota: false,
          CpuCfsPeriod: false,
          PidsLimit: false,
        }),
      };

      await expect(
        verifyCgroupCapabilities(mockClientDinD)
      ).rejects.toThrow(/ALLOW_UNENFORCED_CGROUPS=true is not permitted in deployment mode "custom-cloud-mode"/i);
    });

    test('DEVELOPMENT WITHOUT PROFILE: ALLOW_UNENFORCED_CGROUPS=true is rejected without an explicit local-development profile', async () => {
      // NODE_ENV=development alone is NOT proof that an execution environment is trusted!
      process.env.NODE_ENV = 'development';
      delete process.env.EXECUTION_PROFILE;
      process.env.ALLOW_UNENFORCED_CGROUPS = 'true';

      const mockClientDinD = {
        info: async () => ({
          CgroupDriver: 'none',
          CgroupVersion: '2',
          MemoryLimit: false,
          CPUShares: false,
          CpuCfsQuota: false,
          CpuCfsPeriod: false,
          PidsLimit: false,
        }),
      };

      await expect(
        verifyCgroupCapabilities(mockClientDinD)
      ).rejects.toThrow(/EXECUTION_PROFILE must be explicitly set to a trusted local-development profile/i);
    });

    test('TRUSTED LOCAL-DEV PROFILE: ALLOW_UNENFORCED_CGROUPS=true is accepted when explicitly configured with EXECUTION_PROFILE=local-dev-execution', async () => {
      process.env.NODE_ENV = 'development';
      process.env.EXECUTION_PROFILE = 'local-dev-execution';
      process.env.ALLOW_UNENFORCED_CGROUPS = 'true';
      delete process.env.REQUIRE_CGROUP_ENFORCEMENT;

      const mockClientDinD = {
        info: async () => ({
          CgroupDriver: 'none',
          CgroupVersion: '2',
          MemoryLimit: false,
          CPUShares: false,
          CpuCfsQuota: false,
          CpuCfsPeriod: false,
          PidsLimit: false,
        }),
      };

      const caps = await verifyCgroupCapabilities(mockClientDinD);
      expect(caps.controllersEnforced).toBe(false);
      expect(caps.cgroupDriver).toBe('none');
    });

    test('TRUSTED LOCAL-DEV PROFILE (DIND): ALLOW_UNENFORCED_CGROUPS=true is also accepted for local-dev-dind profile', async () => {
      process.env.NODE_ENV = 'development';
      process.env.EXECUTION_PROFILE = 'local-dev-dind';
      process.env.ALLOW_UNENFORCED_CGROUPS = 'true';

      const mockClientDinD = {
        info: async () => ({
          CgroupDriver: 'none',
          CgroupVersion: '2',
          MemoryLimit: false,
          CPUShares: false,
          CpuCfsQuota: false,
          CpuCfsPeriod: false,
          PidsLimit: false,
        }),
      };

      const caps = await verifyCgroupCapabilities(mockClientDinD);
      expect(caps.controllersEnforced).toBe(false);
    });

    test('PRODUCTION WORKER STARTUP PREFLIGHT: Fails before worker starts or consumes jobs when cgroups are missing', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.EXECUTION_PROFILE;
      delete process.env.ALLOW_UNENFORCED_CGROUPS;

      const mockClientDinD = {
        info: async () => ({
          CgroupDriver: 'none',
          CgroupVersion: '2',
          MemoryLimit: false,
          CPUShares: false,
          CpuCfsQuota: false,
          CpuCfsPeriod: false,
          PidsLimit: false,
        }),
      };

      // Ensure no worker is currently running
      expect(getWorker()).toBeNull();

      // Preflight MUST throw before startWorker() is ever invoked
      await expect(
        validateWorkerPreflight({ dockerClient: mockClientDinD })
      ).rejects.toThrow(/Execution daemon cgroup enforcement is required/i);

      // Verify no BullMQ worker was instantiated or began polling/consuming jobs
      expect(getWorker()).toBeNull();
    });

    test('passes when genuine cgroup driver and ALL six controllers are enabled', async () => {
      const mockClientSystemd = {
        info: async () => ({
          CgroupDriver: 'systemd',
          CgroupVersion: '2',
          MemoryLimit: true,
          CPUShares: true,
          CpuCfsQuota: true,
          CpuCfsPeriod: true,
          PidsLimit: true,
          Warnings: [],
        }),
      };
      const caps = await verifyCgroupCapabilities(mockClientSystemd, { requireCgroups: true });
      expect(caps.cgroupDriver).toBe('systemd');
      expect(caps.controllersEnforced).toBe(true);
      expect(caps.memoryLimit).toBe(true);
      expect(caps.cpuShares).toBe(true);
      expect(caps.cpuCfsQuota).toBe(true);
      expect(caps.cpuCfsPeriod).toBe(true);
      expect(caps.pidsLimit).toBe(true);
    });
  });

});
