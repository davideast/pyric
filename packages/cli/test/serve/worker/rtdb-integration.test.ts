import { expect, test } from 'bun:test';

test('RTDB served-entry integration runs with isolated browser globals', async () => {
  const suite = new URL('./rtdb-served-entry.cases.ts', import.meta.url).pathname;
  // SDK entries bind their backend at evaluation, just as they do on a page.
  // A fresh process keeps other suites' globals and module caches out of it.
  const child = Bun.spawn([process.execPath, 'test', suite], {
    stdout: 'pipe', stderr: 'pipe',
  });
  const deadline = setTimeout(() => child.kill(), 10_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, stdout + stderr).toBe(0);
    expect(stderr).toContain('3 pass');
  } finally { clearTimeout(deadline); child.kill(); }
}, 15_000);
