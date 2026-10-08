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
 */
function parseMemoryToBytes(mem) {
  if (typeof mem === 'number') {
    return mem;
  }
  if (!mem || typeof mem !== 'string') {
    return 256 * 1024 * 1024;
  }
  const match = mem.trim().match(/^(\d+(?:\.\d+)?)\s*([kmgKMG]?)(?:b|B)?$/);
  if (!match) {
    return 256 * 1024 * 1024;
  }
  const val = parseFloat(match[1]);
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
 * @param {number} [options.timeout] - Max execution time in ms (default 5000)
 * @param {string|number} [options.memory] - Max memory (default '256m')
 * @param {string|number} [options.cpu] - CPU quota (default '0.5')
 * @param {boolean} [options.network] - Network access (default false)
 * @returns {Promise<Object>} Execution result object
 */
async function runInSandbox({
  language,
  code,
  timeout = sandboxConfig.timeoutMs,
  memory = sandboxConfig.memory,
  cpu = sandboxConfig.cpu,
  network = sandboxConfig.network,
}) {
  const normalizedLang = (language || '').toLowerCase().trim();
  const imageName = LANGUAGE_IMAGE_MAP[normalizedLang];

  if (!imageName) {
    throw new Error(`Unsupported execution language: ${language}`);
  }

  const docker = getDockerClient();
  const memoryBytes = parseMemoryToBytes(memory);
  const nanoCPUs = parseCpuToNanoCPUs(cpu);
  const timeoutMs = typeof timeout === 'number' && timeout > 0 ? timeout : sandboxConfig.timeoutMs;

  let container = null;
  const startTime = Date.now();
  let timedOut = false;
  let timer = null;

  try {
    // 1. Create ephemeral container with resource limits & isolation
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

    let stdoutBuffer = '';
    let stderrBuffer = '';

    stdoutStream.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
    });

    stderrStream.on('data', (chunk) => {
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

    if (timedOut || outcome.timedOut) {
      return {
        language: normalizedLang,
        stdout: stdoutBuffer,
        stderr: stderrBuffer + (stderrBuffer ? '\n' : '') + `Execution timed out after ${timeoutMs}ms`,
        exitCode: 124,
        executionTimeMs,
        timedOut: true,
        status: 'timeout',
        limits: { timeout: timeoutMs, memory: memoryBytes, cpu: nanoCPUs, network },
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
      limits: { timeout: timeoutMs, memory: memoryBytes, cpu: nanoCPUs, network },
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

