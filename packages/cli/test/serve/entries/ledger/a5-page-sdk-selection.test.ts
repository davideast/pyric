import { expect, test } from 'bun:test';

test('page SDK entries bind the worker before the init response arrives', async () => {
  const fixture = new URL('../fixtures/page-sdk-selection.ts', import.meta.url).pathname;
  // Node's module realm evaluates the unmodified ESM bundle, including its
  // asynchronous imports. A separate process also isolates page globals.
  const child = Bun.spawn([process.env.PYRIC_TEST_NODE ?? 'node', '--experimental-strip-types', '--experimental-vm-modules', fixture], {
    stdout: 'pipe', stderr: 'pipe',
  });
  const deadline = setTimeout(() => child.kill(), 10_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, stdout + stderr).toBe(0);
  } finally { clearTimeout(deadline); child.kill(); }
}, 15_000);
