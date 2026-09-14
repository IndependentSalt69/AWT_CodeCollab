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
  const { language, code, timeout = sandboxConfig.timeoutMs, memory = sandboxConfig.memory } = runSpec;

  if (!language || !code) {
    throw new Error('Language and code are required for execution');
  }

  const rawOutput = await runInSandbox({
    language,
    code,
    timeout,
    memory,
    cpu: sandboxConfig.cpu,
    network: sandboxConfig.network,
  });

  return parseExecutionResult(rawOutput);
};
