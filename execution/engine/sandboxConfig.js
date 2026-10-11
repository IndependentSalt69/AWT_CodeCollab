module.exports = {
  cpu: '0.5',
  memory: '256m',
  timeoutMs: 5000,
  network: false,

  // Authoritative execution policy bounds
  DEFAULT_TIMEOUT_MS: 5000,
  MAX_TIMEOUT_MS: 10000,
  DEFAULT_MEMORY: '256m',
  MAX_MEMORY_BYTES: 256 * 1024 * 1024, // 256 MiB (268,435,456 bytes)
  MAX_CODE_SIZE_BYTES: 64 * 1024,      // 64 KiB (65,536 bytes)
  MAX_OUTPUT_BUFFER_BYTES: 64 * 1024,  // 64 KiB (65,536 bytes)
  MAX_WAITING_JOBS: 25,

  // Configurable isolation runtime & daemon settings (M1.0 Phase B)
  CONTAINER_RUNTIME: process.env.CONTAINER_RUNTIME || '',
  DOCKER_HOST: process.env.DOCKER_HOST || '',
  EXECUTION_PROFILE: process.env.EXECUTION_PROFILE || '',

  // Require genuine kernel cgroup controller enforcement (CPU quota, Memory, PIDs):
  //
  // Strict Security Policy:
  // - Defaults to TRUE (fail-closed) for production, staging, untrusted execution,
  //   unknown deployment modes, and development without an explicit local-dev profile.
  // - Evaluates to FALSE only when explicitly configured for trusted local development
  //   (EXECUTION_PROFILE='local-dev-execution' or 'local-dev-dind' under development/test)
  //   with ALLOW_UNENFORCED_CGROUPS=true or REQUIRE_CGROUP_ENFORCEMENT=false.
  REQUIRE_CGROUP_ENFORCEMENT: (
    process.env.REQUIRE_CGROUP_ENFORCEMENT === 'true' ||
    process.env.REQUIRE_CGROUP_ENFORCEMENT === '1' ||
    !(
      (process.env.EXECUTION_PROFILE === 'local-dev-execution' || process.env.EXECUTION_PROFILE === 'local-dev-dind') &&
      (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') &&
      (process.env.ALLOW_UNENFORCED_CGROUPS === 'true' || process.env.REQUIRE_CGROUP_ENFORCEMENT === 'false')
    )
  ),
};
