const executeCode = require('../../execution/engine/executeCode');
const { getDockerClient, LANGUAGE_IMAGE_MAP } = require('../../execution/engine/executor');

// Live Docker tests. A missing daemon/image fails explicitly, never silently skips.
describe.each(['cpp', 'java'])('%s compiled runner (live sandbox)', (language) => {
  jest.setTimeout(30000);
  let docker;
  let created;
  const sources = language === 'cpp' ? {
    hello: '#include <iostream>\nint main(){std::cout << "Hello from C++!" << std::endl;}',
    bad: 'int main( {',
    failure: 'int main(){return 42;}',
    loop: 'int main(){for(;;){}}',
    output: '#include <cstdio>\nint main(){for(;;) puts("012345678901234567890123456789");}',
    child: '#include <unistd.h>\nint main(){if(fork()==0){for(;;){}} return 0;}',
  } : {
    hello: 'public class Main { public static void main(String[] args) { System.out.println("Hello from Java!"); } }',
    bad: 'public class Main { invalid syntax }',
    failure: 'public class Main { public static void main(String[] a) { throw new RuntimeException("expected failure"); } }',
    loop: 'public class Main { public static void main(String[] a) { while(true) {} } }',
    output: 'public class Main { public static void main(String[] a) { while(true) System.out.println("012345678901234567890123456789"); } }',
    child: 'public class Main { public static void main(String[] a) throws Exception { new ProcessBuilder("sleep", "60").start(); } }',
  };
  beforeAll(async () => {
    docker = getDockerClient();
    await docker.ping();
    await docker.getImage(LANGUAGE_IMAGE_MAP[language]).inspect();
  });
  beforeEach(() => {
    created = [];
    const realCreate = docker.createContainer.bind(docker);
    jest.spyOn(docker, 'createContainer').mockImplementation(async (config) => {
      const container = await realCreate(config);
      created.push(container.id);
      return container;
    });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    // Verifies removal after every outcome, including failure/timeout/output kill.
    for (const id of created) {
      await expect(docker.getContainer(id).inspect()).rejects.toMatchObject({ statusCode: 404 });
    }
  });
  const run = (code, timeout = 5000) => executeCode({ language, code, timeout });
  test('compiles and executes the required smoke program', async () => {
    const result = await run(sources.hello);
    expect(result).toMatchObject({ status: 'completed', exitCode: 0, stderr: '' });
    expect(result.stdout.trim()).toBe(language === 'cpp' ? 'Hello from C++!' : 'Hello from Java!');
  });
  test('returns compiler diagnostics', async () => {
    const result = await run(sources.bad);
    expect(result.status).toBe('failed');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/error/i);
  });
  test('propagates runtime failure', async () => {
    const result = await run(sources.failure);
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(language === 'cpp' ? 42 : 1);
    if (language === 'java') expect(result.stderr).toContain('expected failure');
  });
  test('terminates an infinite loop within the combined compile/run deadline', async () => {
    const start = Date.now();
    const result = await run(sources.loop, 3000);
    expect(result).toMatchObject({ status: 'timeout', exitCode: 124 });
    expect(Date.now() - start).toBeLessThan(7000);
  });
  test('the deadline also terminates compilation', async () => {
    expect(await run(sources.hello, 1)).toMatchObject({ status: 'timeout', exitCode: 124 });
  });
  test('bounds excessive output and kills the container', async () => {
    const result = await run(sources.output);
    expect(result).toMatchObject({ status: 'failed', exitCode: 137 });
    expect(result.stdout).toContain('Output truncated');
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(66000);
  });
  test('removes descendant processes on normal parent exit', async () => {
    expect(await run(sources.child)).toMatchObject({ status: 'completed', exitCode: 0 });
  });
  test.each(['', '   ', '\0', 'x'.repeat(65537)])('rejects invalid source before creating a sandbox (%#)', async (code) => {
    await expect(run(code)).rejects.toThrow();
    expect(created).toHaveLength(0);
  });
  test('rejects unsupported and prototype language identifiers', async () => {
    for (const invalid of ['ruby', '__proto__', 'constructor']) {
      await expect(executeCode({ language: invalid, code: sources.hello })).rejects.toThrow(/Unsupported/);
    }
  });
  if (language === 'java') {
    test.each(['public class Other { }', 'public class Main { }', 'package escape; public class Main { public static void main(String[] a) {} }'])('rejects invalid entry point (%#)', async (code) => {
      expect((await run(code)).status).toBe('failed');
    });
  }
});
