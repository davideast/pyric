/**
 * In-page MCP bridge peer election across writer, read-only, and non-Firebase
 * pages (#2053, #2051).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { startServe } from '../../../src/cli/serve.js';
import { silentServeLogger } from '../../../src/serve/server.js';

function createTempProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ hosting: { public: 'public' } }));
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'public', 'index.html'), '<!doctype html><html><body></body></html>');
  return dir;
}

async function runRealmFixture(args: string[]): Promise<void> {
  const fixture = new URL('./fixtures/inpage-mcp-peer-election.ts', import.meta.url).pathname;
  const child = Bun.spawn(
    [process.env.PYRIC_TEST_NODE ?? 'node', '--experimental-strip-types', '--experimental-vm-modules', fixture, ...args],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const deadline = setTimeout(() => child.kill(), 45_000);
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

describe('in-page MCP bridge peer election (#2053)', () => {
  it('keeps the active writer tab as MCP peer when non-Firebase or read-only tabs connect later', async () => {
    const dir = createTempProject('pyric-2053-persist-');
    const srv = await startServe({
      cwd: dir,
      port: 0,
      host: '127.0.0.1',
      cacheRoot: join(dir, '.cache'),
      persist: true,
      bridge: true,
      permissive: true,
      disableAuditLog: true,
      logger: silentServeLogger(),
    });
    try {
      await runRealmFixture(['persist-app-then-blank-and-readonly', srv.handle.url, srv.sessionToken]);
    } finally {
      await srv.handle.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 55_000);

  it('ignores non-Firebase pages opened after the app tab in ephemeral in-page mode', async () => {
    const dir = createTempProject('pyric-2053-ephemeral-');
    const srv = await startServe({
      cwd: dir,
      port: 0,
      host: '127.0.0.1',
      cacheRoot: join(dir, '.cache'),
      persist: false,
      bridge: true,
      permissive: true,
      disableAuditLog: true,
      logger: silentServeLogger(),
    });
    try {
      await runRealmFixture(['ephemeral-app-then-blank', srv.handle.url, srv.sessionToken]);
    } finally {
      await srv.handle.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 55_000);

  it('disconnects a demoted hidden writer from the MCP bridge so writes reach the new writer (#2051, #2053)', () =>
    runRealmFixture(['writer-demotion-disconnects-bridge', 'http://127.0.0.1:0', '']), 55_000);
});
