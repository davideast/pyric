/**
 * The persist writer role and optimistic concurrency across in-page tabs (#2039, #2051).
 */
import { describe, expect, it } from 'bun:test';
import { resolveNodeExecutable } from '../require-node-on-path.js';

async function runCase(name: string): Promise<void> {
  const nodeBin = resolveNodeExecutable();
  const fixture = new URL('./fixtures/persist-writer-role.ts', import.meta.url).pathname;
  const child = Bun.spawn(
    [nodeBin, '--experimental-strip-types', '--experimental-vm-modules', fixture, name],
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
}

describe('the persist writer role across in-page tabs (#2039, #2051)', () => {
  it('a tab that uses a service keeps a tab that writes later from saving over it', () => runCase('uses-service'), 25_000);
  it('a page that uses no service never claims the role', () => runCase('no-service'), 25_000);
  it('refuses a writer tab returning after >60s hidden when another tab saved newer state (#2051)', () => runCase('hidden-writer'), 25_000);
  it('refuses a tab whose first service call arrives after another tab already saved and closed (#2051)', () => runCase('late-service-claim'), 25_000);
  it('serializes concurrent firestore and auth flushes within one writer tab without self-conflict (#2051)', () => runCase('concurrent-same-tab'), 25_000);
});
