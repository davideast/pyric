import { expect, test } from 'bun:test';

test('served RTDB entries tolerate prior evaluation without SharedWorker', async () => {
  const preload = new URL('../fixtures/without-shared-worker.ts', import.meta.url).pathname;
  const suite = new URL('../rtdb-integration.test.ts', import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, 'test', '--preload', preload, suite], {
    stdout: 'pipe', stderr: 'pipe',
  });
  const deadline = setTimeout(() => child.kill(), 20_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, stdout + stderr).toBe(0);
  } finally { clearTimeout(deadline); child.kill(); }
}, 25_000);
