/**
 * Parses raw container streams into structured execution feedback.
 */
function parseExecutionResult(rawOutput) {
  return {
    stdout: rawOutput.stdout || '',
    stderr: rawOutput.stderr || '',
    exitCode: typeof rawOutput.exitCode === 'number' ? rawOutput.exitCode : 0,
    executionTimeMs: rawOutput.executionTimeMs || 0,
    status: rawOutput.exitCode === 0 ? 'completed' : 'failed',
  };
}

module.exports = { parseExecutionResult };
