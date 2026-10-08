const Docker = require('dockerode');
const executeCode = require('../../execution/engine/executeCode');
const { runInSandbox, parseMemoryToBytes, parseCpuToNanoCPUs } = require('../../execution/engine/executor');
const { parseExecutionResult } = require('../../execution/engine/resultParser');
const sandboxConfig = require('../../execution/engine/sandboxConfig');

describe('Dockerode Execution Orchestrator Tests (M0.5b)', () => {
  const docker = new Docker();

  // Give Docker container operations sufficient test timeout
  jest.setTimeout(30000);

  describe('1. Parameter and Input Validation', () => {
    test('should throw error when runSpec is missing or invalid', async () => {
      await expect(executeCode()).rejects.toThrow('Language and code are required');
      await expect(executeCode({})).rejects.toThrow('Language and code are required');
      await expect(executeCode({ language: 'python' })).rejects.toThrow('Language and code are required');
      await expect(executeCode({ code: 'print(1)' })).rejects.toThrow('Language and code are required');
    });

    test('should reject unsupported languages (e.g. cpp, java, rust)', async () => {
      await expect(
        executeCode({ language: 'cpp', code: 'int main() { return 0; }' })
      ).rejects.toThrow(/unsupported execution language: cpp/i);

      await expect(
        executeCode({ language: 'java', code: 'public class Solution {}' })
      ).rejects.toThrow(/unsupported execution language: java/i);

      await expect(
        executeCode({ language: 'ruby', code: 'puts "hello"' })
      ).rejects.toThrow(/unsupported execution language: ruby/i);
    });
  });

  describe('2. Python Execution via Dockerode (Valid Execution)', () => {
    test('should execute basic hello world in Docker container', async () => {
      const result = await executeCode({
        language: 'python',
        code: 'print("Hello from Dockerode Orchestrator!")',
      });

      expect(result.status).toBe('completed');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('Hello from Dockerode Orchestrator!');
      expect(result.stderr).toBe('');
      expect(result.executionTimeMs).toBeGreaterThan(0);
    });

    test('should execute multi-line python code and computations', async () => {
      const code = [
        'results = [i ** 2 for i in range(5)]',
        'for r in results:',
        '    print(r)',
      ].join('\n');

      const result = await executeCode({
        language: 'python',
        code,
      });

      expect(result.status).toBe('completed');
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split(/\r?\n/);
      expect(lines).toEqual(['0', '1', '4', '9', '16']);
      expect(result.stderr).toBe('');
    });

    test('should handle special characters, quotes, and shell characters safely without injection', async () => {
      const code = 'print("""Quotes: \' " $PATH `echo injection` \\nSpecial symbols: ; & | < >""")';

      const result = await executeCode({
        language: 'python',
        code,
      });

      expect(result.status).toBe('completed');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Quotes: \' " $PATH `echo injection`');
      expect(result.stdout).toContain('Special symbols: ; & | < >');
      expect(result.stderr).toBe('');
    });
  });

  describe('3. Python Runtime and Syntax Failure Handling', () => {
    test('should capture runtime exceptions with stderr and non-zero exit code', async () => {
      const result = await executeCode({
        language: 'python',
        code: 'raise ValueError("Simulated runtime error from container")',
      });

      expect(result.status).toBe('failed');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('ValueError: Simulated runtime error from container');
    });

    test('should capture syntax errors with stderr and non-zero exit code', async () => {
      const result = await executeCode({
        language: 'python',
        code: 'def malformed_syntax(',
      });

      expect(result.status).toBe('failed');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('SyntaxError');
    });

    test('should propagate custom sys.exit code', async () => {
      const result = await executeCode({
        language: 'python',
        code: 'import sys\nsys.exit(42)',
      });

      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(42);
    });
  });

  describe('4. Execution Timeout Enforcement', () => {
    test('should kill container and classify status as timeout when exceeding limit', async () => {
      const startTime = Date.now();
      const result = await executeCode({
        language: 'python',
        code: 'import time\ntime.sleep(10)\nprint("Should not finish")',
        timeout: 1200,
      });

      const elapsed = Date.now() - startTime;

      expect(result.status).toBe('timeout');
      expect(result.exitCode).toBe(124);
      expect(result.stderr).toContain('Execution timed out after 1200ms');
      expect(elapsed).toBeGreaterThanOrEqual(1000);
      expect(elapsed).toBeLessThan(8000);
    });
  });

  describe('5. Ephemeral Container Lifecycle and Cleanup', () => {
    test('should ensure no lingering containers remain after execution', async () => {
      // Record initial containers
      const containersBefore = await docker.listContainers({ all: true });

      await executeCode({
        language: 'python',
        code: 'print("Ephemeral test execution")',
      });

      // Verify no extra container remains
      const containersAfter = await docker.listContainers({ all: true });
      const orphanRunners = containersAfter.filter(
        (c) =>
          c.Image.includes('codecollab-runner-python') &&
          !containersBefore.some((b) => b.Id === c.Id)
      );

      expect(orphanRunners.length).toBe(0);
    });
  });

  describe('6. Result Parser and Sandbox Utilities', () => {
    test('parseExecutionResult should correctly categorize statuses', () => {
      expect(parseExecutionResult({ exitCode: 0, stdout: 'ok' })).toEqual({
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
        executionTimeMs: 0,
        status: 'completed',
      });

      expect(parseExecutionResult({ exitCode: 1, stderr: 'err' })).toEqual({
        stdout: '',
        stderr: 'err',
        exitCode: 1,
        executionTimeMs: 0,
        status: 'failed',
      });

      expect(parseExecutionResult({ timedOut: true, exitCode: 124 })).toEqual({
        stdout: '',
        stderr: '',
        exitCode: 124,
        executionTimeMs: 0,
        status: 'timeout',
      });

      expect(parseExecutionResult({ status: 'timeout', exitCode: 124 })).toEqual({
        stdout: '',
        stderr: '',
        exitCode: 124,
        executionTimeMs: 0,
        status: 'timeout',
      });
    });

    test('parseMemoryToBytes converts string and number formats', () => {
      expect(parseMemoryToBytes('256m')).toBe(256 * 1024 * 1024);
      expect(parseMemoryToBytes('512M')).toBe(512 * 1024 * 1024);
      expect(parseMemoryToBytes('1g')).toBe(1024 * 1024 * 1024);
      expect(parseMemoryToBytes('64k')).toBe(64 * 1024);
      expect(parseMemoryToBytes(1048576)).toBe(1048576);
      expect(parseMemoryToBytes(null)).toBe(256 * 1024 * 1024);
    });

    test('parseCpuToNanoCPUs converts cpu string to NanoCPUs', () => {
      expect(parseCpuToNanoCPUs('0.5')).toBe(500000000);
      expect(parseCpuToNanoCPUs('1.0')).toBe(1000000000);
      expect(parseCpuToNanoCPUs('2')).toBe(2000000000);
      expect(parseCpuToNanoCPUs(0.25)).toBe(250000000);
      expect(parseCpuToNanoCPUs(null)).toBe(500000000);
    });
  });
});

