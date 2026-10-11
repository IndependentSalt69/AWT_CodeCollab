const { runInSandbox } = require('./executor');
const { parseExecutionResult } = require('./resultParser');
const sandboxConfig = require('./sandboxConfig');

/**
 * Executes user-submitted code in a language-specific Docker container sandbox.
 * @param {Object} runSpec
 * @param {('python'|'java'|'cpp')} runSpec.language
 * @param {string} runSpec.code
 * @param {number} [runSpec.timeout]
 * @param {string} [runSpec.memory]
 * @returns {Promise<Object>} Execution result (stdout, stderr, exitCode, executionTimeMs)
 */
module.exports = async function executeCode(runSpec) {
  if (!runSpec || typeof runSpec !== 'object') {
    throw new Error('Language and code are required for execution');
  }

  const {
    language,
    code,
    timeout = sandboxConfig.DEFAULT_TIMEOUT_MS,
    memory = sandboxConfig.DEFAULT_MEMORY,
  } = runSpec;

  if (!language || !code) {
    throw new Error('Language and code are required for execution');
  }

  if (Buffer.byteLength(code, 'utf8') > sandboxConfig.MAX_CODE_SIZE_BYTES) {
    throw new Error(`Code exceeds maximum allowed size of ${sandboxConfig.MAX_CODE_SIZE_BYTES / 1024}KB`);
  }

  const rawOutput = await runInSandbox({
    language,
    code,
    timeout,
    memory,
    cpu: sandboxConfig.cpu,
    network: sandboxConfig.network,
    runtime: runSpec.runtime || sandboxConfig.CONTAINER_RUNTIME,
  });

  return parseExecutionResult(rawOutput);
};
