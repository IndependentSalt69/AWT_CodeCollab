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
};

