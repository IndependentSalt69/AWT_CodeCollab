const Docker = require('dockerode');
const { PassThrough } = require('stream');
const sandboxConfig = require('./sandboxConfig');

// Singleton Docker instance for the execution engine
let dockerInstance = null;
function getDockerClient() {
  if (!dockerInstance) {
    dockerInstance = new Docker();
  }
  return dockerInstance;
}

const LANGUAGE_IMAGE_MAP = {
  python: 'codecollab-runner-python:latest',
};

/**
 * Converts memory string (e.g. '256m', '512m', '1g') or number to bytes.
 * Returns null if input is invalid, NaN, or non-positive.
 */
function parseMemoryToBytes(mem) {
  if (mem === undefined || mem === null) {
    return sandboxConfig.MAX_MEMORY_BYTES;
  }
  if (typeof mem === 'number') {
    if (isNaN(mem) || mem <= 0 || !isFinite(mem)) {
      return null;
    }
    return Math.round(mem);
  }
  if (typeof mem !== 'string') {
    return null;
  }
  const match = mem.trim().match(/^(\d+(?:\.\d+)?)\s*([kmgKMG]?)(?:b|B)?$/i);
  if (!match) {
    return null;
  }
  const val = parseFloat(match[1]);
  if (isNaN(val) || val <= 0 || !isFinite(val)) {
    return null;
  }
  const unit = match[2].toLowerCase();
  if (unit === 'g') return Math.round(val * 1024 * 1024 * 1024);
  if (unit === 'm') return Math.round(val * 1024 * 1024);
  if (unit === 'k') return Math.round(val * 1024);
  return Math.round(val);
}

/**
 * Converts CPU quota string or number to NanoCPUs (1 CPU = 1e9 NanoCPUs).
 */
function parseCpuToNanoCPUs(cpu) {
  if (typeof cpu === 'number') {
    return Math.round(cpu * 1e9);
  }
  if (!cpu || typeof cpu !== 'string') {
    return 500000000; // 0.5 CPU
  }
  const parsed = parseFloat(cpu);
  return isNaN(parsed) ? 500000000 : Math.round(parsed * 1e9);
}

/**
 * Runs submitted code in an ephemeral Docker container.
 *
 * @param {Object} options
 * @param {string} options.language - 'python'
 * @param {string} options.code - User source code
 * @param {number} [options.timeout] - Max execution time in ms (default 5000, capped at 10000)
 * @param {string|number} [options.memory] - Max memory (default '256m', capped at 256m)
 * @param {string|number} [options.cpu] - CPU quota (default '0.5')
 * @param {boolean} [options.network] - Network access (default false)
 * @returns {Promise<Object>} Execution result object
 */
async function runInSandbox({
  language,
  code,
  timeout = sandboxConfig.DEFAULT_TIMEOUT_MS,
  memory = sandboxConfig.DEFAULT_MEMORY,
  cpu = sandboxConfig.cpu,
  network = sandboxConfig.network,
}) {
  const normalizedLang = (language || '').toLowerCase().trim();
  const imageName = LANGUAGE_IMAGE_MAP[normalizedLang];

  if (!imageName) {
    throw new Error(`Unsupported execution language: ${language}`);
  }

  if (typeof code !== 'string') {
    throw new Error('Code must be a string');
  }

  // Defensive code size safety boundary (64 KiB)
  if (Buffer.byteLength(code, 'utf8') > sandboxConfig.MAX_CODE_SIZE_BYTES) {
    throw new Error(`Code exceeds maximum allowed size of ${sandboxConfig.MAX_CODE_SIZE_BYTES / 1024}KB`);
  }

  const docker = getDockerClient();

  // Parse and enforce hard safety ceilings
  let parsedMemoryBytes = parseMemoryToBytes(memory);
  if (parsedMemoryBytes === null || parsedMemoryBytes <= 0) {
    parsedMemoryBytes = sandboxConfig.MAX_MEMORY_BYTES;
  }
  const memoryBytes = Math.min(parsedMemoryBytes, sandboxConfig.MAX_MEMORY_BYTES);

  const nanoCPUs = parseCpuToNanoCPUs(cpu);

  let rawTimeout = typeof timeout === 'number' && timeout > 0 && !isNaN(timeout)
    ? timeout
    : sandboxConfig.DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(rawTimeout, sandboxConfig.MAX_TIMEOUT_MS);

  let container = null;
  const startTime = Date.now();
  let timedOut = false;
  let timer = null;

  try {
    // 1. Create ephemeral container with resource limits, read-only rootfs & isolation
    container = await docker.createContainer({
      Image: imageName,
      Cmd: ['--code', code],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      User: 'sandbox',
      HostConfig: {
        Memory: memoryBytes,
        MemorySwap: memoryBytes,
        NanoCPUs: nanoCPUs,
        NetworkMode: network ? 'bridge' : 'none',
        PidsLimit: 64,
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=32m' },
      },
    });

    // 2. Attach multiplexed streams before starting
    const stream = await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
    });

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();

    const MAX_OUTPUT = sandboxConfig.MAX_OUTPUT_BUFFER_BYTES;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let outputLimitExceeded = false;
    let limitExceededReason = '';

    stdoutStream.on('data', (chunk) => {
      if (outputLimitExceeded) return;
      const chunkBytes = Buffer.byteLength(chunk);
      if (stdoutBytes + chunkBytes > MAX_OUTPUT) {
        outputLimitExceeded = true;
        limitExceededReason = 'stdout exceeded maximum limit of 64KB';
        const remaining = Math.max(0, MAX_OUTPUT - stdoutBytes);
        if (remaining > 0) {
          stdoutBuffer += chunk.slice(0, remaining).toString('utf8');
          stdoutBytes += remaining;
        }
        stdoutBuffer += '\n[Output truncated: exceeded 64KB limit]';
        if (container) {
          container.kill().catch(() => {});
        }
        return;
      }
      stdoutBytes += chunkBytes;
      stdoutBuffer += chunk.toString('utf8');
    });

    stderrStream.on('data', (chunk) => {
      if (outputLimitExceeded) return;
      const chunkBytes = Buffer.byteLength(chunk);
      if (stderrBytes + chunkBytes > MAX_OUTPUT) {
        outputLimitExceeded = true;
        limitExceededReason = 'stderr exceeded maximum limit of 64KB';
        const remaining = Math.max(0, MAX_OUTPUT - stderrBytes);
        if (remaining > 0) {
          stderrBuffer += chunk.slice(0, remaining).toString('utf8');
          stderrBytes += remaining;
        }
        stderrBuffer += '\n[Output truncated: exceeded 64KB limit]';
        if (container) {
          container.kill().catch(() => {});
        }
        return;
      }
      stderrBytes += chunkBytes;
      stderrBuffer += chunk.toString('utf8');
    });

    docker.modem.demuxStream(stream, stdoutStream, stderrStream);

    // 3. Start container
    await container.start();

    // 4. Set timeout enforcement
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(async () => {
        timedOut = true;
        try {
          await container.kill();
        } catch (_) {
          // Container may have already exited
        }
        resolve({ timedOut: true });
      }, timeoutMs);
    });

    // 5. Wait for container completion or timeout
    const waitPromise = container.wait().then((data) => ({ timedOut: false, data }));

    const outcome = await Promise.race([waitPromise, timeoutPromise]);

    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    // Allow stream chunks to finish flushing
    await new Promise((resolve) => setTimeout(resolve, 50));

    const executionTimeMs = Date.now() - startTime;

    // Output limit termination takes precedence over timeout
    if (outputLimitExceeded) {
      return {
        language: normalizedLang,
        stdout: stdoutBuffer,
        stderr: stderrBuffer + (stderrBuffer ? '\n' : '') + `Execution failed: ${limitExceededReason}`,
        exitCode: 137,
        executionTimeMs,
        timedOut: false,
        outputLimitExceeded: true,
        status: 'failed',
        limits: {
          timeout: timeoutMs,
          memory: memoryBytes,
          cpu: nanoCPUs,
          network,
          maxOutputBytes: MAX_OUTPUT,
        },
      };
    }

    if (timedOut || outcome.timedOut) {
      return {
        language: normalizedLang,
        stdout: stdoutBuffer,
        stderr: stderrBuffer + (stderrBuffer ? '\n' : '') + `Execution timed out after ${timeoutMs}ms`,
        exitCode: 124,
        executionTimeMs,
        timedOut: true,
        status: 'timeout',
        limits: {
          timeout: timeoutMs,
          memory: memoryBytes,
          cpu: nanoCPUs,
          network,
          maxOutputBytes: MAX_OUTPUT,
        },
      };
    }

    const exitCode = outcome.data && typeof outcome.data.StatusCode === 'number' ? outcome.data.StatusCode : 0;

    return {
      language: normalizedLang,
      stdout: stdoutBuffer,
      stderr: stderrBuffer,
      exitCode,
      executionTimeMs,
      timedOut: false,
      status: exitCode === 0 ? 'completed' : 'failed',
      limits: {
        timeout: timeoutMs,
        memory: memoryBytes,
        cpu: nanoCPUs,
        network,
        maxOutputBytes: MAX_OUTPUT,
      },
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    // 6. Force remove container to guarantee ephemeral cleanup
    if (container) {
      try {
        await container.remove({ force: true });
      } catch (_) {
        // Container might already be removed
      }
    }
  }
}

module.exports = {
  runInSandbox,
  parseMemoryToBytes,
  parseCpuToNanoCPUs,
  LANGUAGE_IMAGE_MAP,
};

