/**
 * In-page browser runtime capture snapshots active Firestore, RTDB, and
 * Storage rules after hot-reload instead of stale boot payload rules.
 */
import { describe, expect, it } from 'bun:test';

describe('in-page runtime active-rules capture', () => {
  it('captures boot-time storageRules and updated active Firestore, RTDB, and Storage rules', async () => {
    const fixture = new URL('./fixtures/runtime-capture-rules.ts', import.meta.url).pathname;
    const child = Bun.spawn(
      [process.env.PYRIC_TEST_NODE ?? 'node', '--experimental-strip-types', '--experimental-vm-modules', fixture],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const deadline = setTimeout(() => child.kill(), 20_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, stdout + stderr).toBe(0);
    } finally {
      clearTimeout(deadline);
      child.kill();
    }
  }, 25_000);
});
