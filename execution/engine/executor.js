const Docker = require('dockerode');
const { PassThrough } = require('stream');
const sandboxConfig = require('./sandboxConfig');
const { parseMemoryToBytes, parseCpuToNanoCPUs } = require('./resourceLimits');

const { parseDockerConnectionConfig, validateRuntime, verifyRuntimeAvailable } = require('./dockerConfig');

// Singleton Docker instance for the execution engine
let dockerInstance = null;
function getDockerClient(customConfig) {
  if (customConfig) {
    const opts = typeof customConfig === 'string'
      ? parseDockerConnectionConfig(customConfig)
      : customConfig;
    return new Docker(opts);
  }
  if (!dockerInstance) {
    const dockerOpts = parseDockerConnectionConfig(process.env.DOCKER_HOST);
    dockerInstance = new Docker(dockerOpts);
  }
  return dockerInstance;
}

function resetDockerClient() {
  dockerInstance = null;
}

const LANGUAGE_IMAGE_MAP = {
  python: 'codecollab-runner-python:latest',
};

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
  runtime = sandboxConfig.CONTAINER_RUNTIME,
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

  // Validate container runtime (runc or runsc)
  const selectedRuntime = validateRuntime(runtime);

  const docker = getDockerClient();

  // If gVisor (runsc) is requested, verify daemon support; never silently downgrade
  if (selectedRuntime === 'runsc') {
    await verifyRuntimeAvailable(docker, 'runsc');
  }

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
        ...(selectedRuntime === 'runsc' ? { Runtime: 'runsc' } : {}),
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
          runtime: selectedRuntime,
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
          runtime: selectedRuntime,
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
        runtime: selectedRuntime,
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
  getDockerClient,
  resetDockerClient,
  validateRuntime,
  verifyRuntimeAvailable,
  parseMemoryToBytes,
  parseCpuToNanoCPUs,
  LANGUAGE_IMAGE_MAP,
};

