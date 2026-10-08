/**
 * Parses raw container streams into structured execution feedback.
 */
function parseExecutionResult(rawOutput) {
  let status = 'completed';
  if (rawOutput.timedOut || rawOutput.status === 'timeout') {
    status = 'timeout';
  } else if (rawOutput.exitCode !== 0 || rawOutput.status === 'failed') {
    status = 'failed';
  }

  return {
    stdout: rawOutput.stdout || '',
    stderr: rawOutput.stderr || '',
    exitCode: typeof rawOutput.exitCode === 'number' ? rawOutput.exitCode : 0,
    executionTimeMs: rawOutput.executionTimeMs || 0,
    status: rawOutput.status && ['completed', 'failed', 'timeout'].includes(rawOutput.status) ? rawOutput.status : status,
  };
}

module.exports = { parseExecutionResult };

