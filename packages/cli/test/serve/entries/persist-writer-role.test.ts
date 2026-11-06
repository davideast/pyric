/**
 * The persist writer role across two in-page tabs of one project (#2039).
 *
 * Tab sync carries Firestore documents and accounts between tabs, not RTDB,
 * Storage or auth history, so a tab that saves after another tab's saves
 * would post its own load-time copy of those and revert them. The single
 * writer lock prevents it: a tab that uses a service claims the role then,
 * and a second tab is refused and goes read-only. A page that uses no
 * service never claims it. The cases run in `fixtures/persist-writer-role.ts`.
 */
import { describe, expect, it } from 'bun:test';

async function runCase(name: string): Promise<void> {
  const fixture = new URL('./fixtures/persist-writer-role.ts', import.meta.url).pathname;
  // Node's module realm evaluates the runtime's top-level await; a separate
  // process also isolates each tab's page globals.
  const child = Bun.spawn([process.env.PYRIC_TEST_NODE ?? 'node', '--experimental-strip-types', '--experimental-vm-modules', fixture, name], {
    stdout: 'pipe', stderr: 'pipe',
  });
  const deadline = setTimeout(() => child.kill(), 20_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, stdout + stderr).toBe(0);
  } finally {
    clearTimeout(deadline);
    child.kill();
  }
}

describe('the persist writer role across in-page tabs (#2039)', () => {
  it('a tab that uses a service keeps a tab that writes later from saving over it', () => runCase('uses-service'), 25_000);
  it('a page that uses no service never claims the role', () => runCase('no-service'), 25_000);
});
