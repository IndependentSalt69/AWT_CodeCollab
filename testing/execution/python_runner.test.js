const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const RUNNER_SCRIPT = path.resolve(__dirname, '../../execution/runners/python/runner.py');

/**
 * Helper function to run the Python runner subprocess and capture stdout, stderr, and exitCode.
 */
function runPythonRunner({ args = [], env = {}, stdinData = '' } = {}) {
  return new Promise((resolve) => {
    const child = spawn('python', [RUNNER_SCRIPT, ...args], {
      env: { ...process.env, ...env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    if (stdinData) {
      child.stdin.write(stdinData);
    }
    child.stdin.end();

    child.on('close', (exitCode) => {
      resolve({
        stdout,
        stderr,
        exitCode,
      });
    });

    child.on('error', (err) => {
      resolve({
        stdout,
        stderr: stderr + `\nProcess error: ${err.message}`,
        exitCode: -1,
      });
    });
  });
}

describe('Python 3.11 Dynamic Runner Tests (M0.5a)', () => {
  let tempDir;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codecollab-py-runner-'));
  });

  afterAll(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('1. Hello world execution', async () => {
    const codeFile = path.join(tempDir, 'hello.py');
    fs.writeFileSync(codeFile, 'print("Hello CodeCollab")\n');

    const result = await runPythonRunner({ args: [codeFile] });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('Hello CodeCollab');
    expect(result.stderr).toBe('');
  });

  test('2. Multiple output lines', async () => {
    const codeFile = path.join(tempDir, 'multi_line.py');
    fs.writeFileSync(
      codeFile,
      'for i in range(3):\n    print(f"Line {i + 1}")\n'
    );

    const result = await runPythonRunner({ args: [codeFile] });

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split(/\r?\n/);
    expect(lines).toEqual(['Line 1', 'Line 2', 'Line 3']);
    expect(result.stderr).toBe('');
  });

  test('3. Runtime error handling', async () => {
    const codeFile = path.join(tempDir, 'runtime_err.py');
    fs.writeFileSync(codeFile, 'raise Exception("test error")\n');

    const result = await runPythonRunner({ args: [codeFile] });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Exception: test error');
  });

  test('4. Syntax error handling', async () => {
    const codeFile = path.join(tempDir, 'syntax_err.py');
    fs.writeFileSync(codeFile, 'def broken_func(\n');

    const result = await runPythonRunner({ args: [codeFile] });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('SyntaxError');
  });

  test('5. Dynamic stdin support', async () => {
    const codeFile = path.join(tempDir, 'stdin_test.py');
    fs.writeFileSync(
      codeFile,
      'import sys\nval = sys.stdin.read().strip()\nprint(f"Received: {val}")\n'
    );

    const result = await runPythonRunner({
      args: [codeFile],
      stdinData: 'Custom Input Data 123',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('Received: Custom Input Data 123');
    expect(result.stderr).toBe('');
  });

  test('6. Empty submission handling', async () => {
    const codeFile = path.join(tempDir, 'empty.py');
    fs.writeFileSync(codeFile, '');

    const result = await runPythonRunner({ args: [codeFile] });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  test('7. Missing / invalid submission file', async () => {
    const nonexistentPath = path.join(tempDir, 'does_not_exist.py');

    const result = await runPythonRunner({ args: [nonexistentPath] });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Specified submission file not found');
  });

  test('8. No arguments provided and no default files', async () => {
    // Run runner from isolated temp dir with no submission files
    const result = await runPythonRunner({ args: [] });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No Python submission file or code provided to runner');
  });

  test('9. Execution via SUBMISSION_FILE environment variable', async () => {
    const codeFile = path.join(tempDir, 'env_file.py');
    fs.writeFileSync(codeFile, 'print("Executed via SUBMISSION_FILE env")\n');

    const result = await runPythonRunner({
      env: { SUBMISSION_FILE: codeFile },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('Executed via SUBMISSION_FILE env');
  });

  test('10. Execution via SUBMISSION_CODE environment variable', async () => {
    const result = await runPythonRunner({
      env: { SUBMISSION_CODE: 'print("Executed via SUBMISSION_CODE env")' },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('Executed via SUBMISSION_CODE env');
  });

  test('11. Execution via --code CLI argument', async () => {
    const result = await runPythonRunner({
      args: ['--code', 'print(2 + 2)'],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('4');
  });

  test('12. Custom exit code propagation (sys.exit)', async () => {
    const codeFile = path.join(tempDir, 'custom_exit.py');
    fs.writeFileSync(codeFile, 'import sys\nsys.exit(42)\n');

    const result = await runPythonRunner({ args: [codeFile] });

    expect(result.exitCode).toBe(42);
  });
});
