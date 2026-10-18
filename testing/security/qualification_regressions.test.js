const { classifyMemoryEnforcement: memory, classifyPidEnforcement: pid,
  classifyCpuEnforcement: cpu, classifyGvisorIntegration: gvisor,
  resolveOverallVerdict, STATUS_NOT_QUALIFIED } = require('../../eval/enforcement-classifier');
const { EnforcementTracker, buildPidProbeScript, probeMemoryEnforcement, probePidEnforcement, probeCpuEnforcement } = require('../../eval/resource-probes');
const { verifyCgroupCapabilities } = require('../../execution/engine/dockerConfig');
const Docker = require('dockerode');
const { runInSandbox, resetDockerClient } = require('../../execution/engine/executor');
const { PassThrough } = require('stream');

describe('Qualification rejects incomplete or contradictory evidence', () => {
  test.each([null, 'max', '268435456', '134217728garbage'])('rejects OOM with incorrect memory.max %s', (limit) => {
    expect(memory({ observedMemoryMax: limit, oomKilled: true, exitCode: 137 }).status).toBe('FAIL');
  });
  const pidEvidence = { configuredPidsLimit: 10, observedPidsMax: '10', childrenSpawned: 9,
    childrenReaped: 9, forkBlocked: true, pidsEventsDelta: { max: 1 }, exitCode: 0 };
  test.each([
    { observedPidsMax: 'max' },
    { observedPidsMax: null },
    { childrenReaped: 0 },
    { childrenReaped: 8 },
    { childrenReaped: null },
    { childrenReaped: undefined },
    { childrenReaped: '9' },
    { cleanupFailures: ['waitpid(101):unexpected_pid=0'] },
    { stdout: 'CLEANUP_FAILURES:waitpid(101):error' },
    { stdout: 'REAP_INCOMPLETE:spawned=9,reaped=8' },
    { exitCode: 124 },
    { timedOut: true },
  ])('rejects incomplete PID evidence %j', (change) => {
    expect(pid({ ...pidEvidence, ...change }).status).toBe('FAIL');
  });
  const cpuEvidence = { requestedNanoCPUs: 500000000, observedCpuMax: '50000 100000',
    wallSeconds: 2, processCpuSeconds: 1, cpuStatDelta: { nr_throttled: 10 }, exitCode: 0 };
  test.each([{ observedCpuMax: 'max 100000' }, { observedCpuMax: '100000 100000' }, { exitCode: 1 },
    { processCpuSeconds: 2 }, { timedOut: true }])('rejects incomplete CPU evidence %j', (change) => {
    expect(cpu({ ...cpuEvidence, ...change }).status).toBe('FAIL');
  });
  test.each([{ containerStarted: false }, { exitCode: 1 }, { timedOut: true }, { runtimeRequested: 'runc' }, { procVersion: 'Linux', stdout: 'gVisor' }])('requires successful gVisor workload %j', (change) => {
    expect(gvisor({ runtimeRegistered: true, runtimeRequested: 'runsc', containerStarted: true,
      exitCode: 0, procVersion: 'Linux gVisor', ...change }).status).toBe('FAIL');
  });
  test('four resource checks alone cannot qualify the application', () => {
    const env = { platform: 'linux', connected: true, isRootless: true,
      cgroupControllersEnforced: true, cgroupDriver: 'systemd', cgroupVersion: '2' };
    const checks = Object.fromEntries(['memory', 'pid', 'cpu', 'gvisor'].map(k => [k, { status: 'PASS' }]));
    expect(resolveOverallVerdict(env, checks)).toBe(STATUS_NOT_QUALIFIED);
    for (const name of ['timeout', 'output', 'cleanup', 'authorization', 'roomIsolation']) checks[name] = { status: 'PASS' };
    checks.pidProduction = { status: 'FAIL' };
    expect(resolveOverallVerdict(env, checks)).toBe(STATUS_NOT_QUALIFIED);
  });
  test('cleanup retains failed removals for retry; only 404 confirms absence', async () => {
    const tracker = new EnforcementTracker('test');
    tracker.track('failed'); tracker.track('gone');
    const client = { getContainer: id => ({ remove: async () => { throw { statusCode: id === 'gone' ? 404 : 403 }; } }) };
    await tracker.cleanup(client);
    expect([...tracker.createdContainerIds]).toEqual(['failed']);
    await tracker.cleanup({ getContainer: () => ({ remove: async () => {} }) });
    expect(tracker.createdContainerIds.size).toBe(0);
  });
  test('production PID workload attempts beyond 64 without an unbounded fork loop', () => {
    expect(buildPidProbeScript(64)).toContain('max_attempts = 79');
    expect(() => buildPidProbeScript(10000)).toThrow();
  });
  test.each([probeMemoryEnforcement, probePidEnforcement, probeCpuEnforcement])('resource probe %p explicitly uses runsc', async (probe) => {
    const client = { createContainer: jest.fn().mockResolvedValue({
      id: 'probe', attach: async () => new PassThrough(), start: async () => {},
      wait: async () => ({ StatusCode: 0 }), inspect: async () => ({}), remove: async () => {},
    }), modem: { demuxStream: () => {} } };
    await probe(client, new EnforcementTracker('runtime-regression'));
    expect(client.createContainer.mock.calls[0][0].HostConfig.Runtime).toBe('runsc');
  });
  test.each(['production', 'staging', ''])('option cannot disable cgroups in %s', async (nodeEnv) => {
    await expect(verifyCgroupCapabilities({ info: async () => ({ CgroupDriver: 'none' }) }, {
      nodeEnv, executionProfile: 'production', allowUnenforcedCgroups: false, requireCgroups: false,
    })).rejects.toThrow(/not permitted/);
  });
});

describe.each(['cpp', 'java'])('%s sandbox policy and failure cleanup (mock daemon)', (language) => {
  beforeEach(() => resetDockerClient());
  afterEach(() => jest.restoreAllMocks());
  test('missing image fails without execution or host fallback', async () => {
    const create = jest.spyOn(Docker.prototype, 'createContainer').mockRejectedValue(new Error('No such image in execution daemon'));
    await expect(runInSandbox({ language, code: 'source' })).rejects.toThrow(/No such image/);
    expect(create.mock.calls[0][0].Image).toBe(`codecollab-runner-${language}:latest`);
  });
  test('uses argument arrays, restricted scratch mounts, and resource limits', async () => {
    const container = { attach: async () => new PassThrough(), start: async () => {}, wait: async () => ({ StatusCode: 1 }), remove: jest.fn().mockResolvedValue() };
    const create = jest.spyOn(Docker.prototype, 'createContainer').mockResolvedValue(container);
    jest.spyOn(require('docker-modem').prototype, 'demuxStream').mockImplementation(() => {});
    await runInSandbox({ language, code: '$(touch /app/escape); `id`' });
    const config = create.mock.calls[0][0];
    expect(config.Cmd).toEqual(['--code', '$(touch /app/escape); `id`']);
    expect(config.User).toBe('sandbox');
    expect(config.HostConfig).toMatchObject({ Memory: 268435456, MemorySwap: 268435456, NanoCPUs: 500000000,
      PidsLimit: 64, NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'] });
    expect(config.HostConfig.Tmpfs['/tmp']).toContain('noexec');
    expect(config.HostConfig.Tmpfs['/work']).toContain(language === 'cpp' ? ',exec,' : ',noexec,');
    expect(config.HostConfig.Binds).toBeUndefined();
    expect(container.remove).toHaveBeenCalledWith({ force: true });
  });
  test('reports cleanup failure rather than returning success', async () => {
    const container = { attach: async () => new PassThrough(), start: async () => {}, wait: async () => ({ StatusCode: 0 }), remove: async () => { throw new Error('permission denied'); } };
    jest.spyOn(Docker.prototype, 'createContainer').mockResolvedValue(container);
    jest.spyOn(require('docker-modem').prototype, 'demuxStream').mockImplementation(() => {});
    await expect(runInSandbox({ language, code: 'source' })).rejects.toThrow(/cleanup failed/);
  });
});
