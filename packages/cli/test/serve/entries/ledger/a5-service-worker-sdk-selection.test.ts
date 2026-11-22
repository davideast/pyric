import { expect, test } from 'bun:test';
import { resolveNodeExecutable } from '../../require-node-on-path.js';

for (const transport of ['relay', 'hosted']) {
  test(`Service Worker SDK entries read through ${transport} after deferred initialization`, async () => {
    const nodeBin = resolveNodeExecutable();
    const fixture = new URL('../fixtures/page-sdk-selection.ts', import.meta.url).pathname;
    const child = Bun.spawn([nodeBin, '--experimental-strip-types', '--experimental-vm-modules', fixture, transport], {
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
}
