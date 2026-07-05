/** `pyric mcp-proxy` discovery (plugin wiring). The stdio↔HTTP relay itself
 *  is exercised by the e2e relay test against a live serve. */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverServe } from '../../src/cli/mcp-proxy.js';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import { silentServeLogger } from '../../src/serve/server.js';

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-proxy-'));
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ hosting: { public: 'public' } }));
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'public', 'index.html'), '<!doctype html><html><head></head><body>p</body></html>');
  return dir;
}

const stops: ServeRuntime[] = [];
afterAll(async () => {
  for (const r of stops) await r.handle.stop();
});

describe('discoverServe', () => {
  // Empty scan set keeps these hermetic: the default scan probes real localhost
  // ports (incl. 5174) which a dev machine may legitimately have a server on.
  const noScan: number[] = [];

  it('returns null when nothing is running in the cwd', async () => {
    expect(await discoverServe(mkdtempSync(join(tmpdir(), 'pyric-empty-')), undefined, noScan)).toBeNull();
  });

  it('reads serve\'s .pyric/serve.json pointer and validates it via health', async () => {
    const cwd = project();
    const r = await startServe({
      cwd, port: 0, cacheRoot: join(cwd, '.cache'),
      bridge: true, disableAuditLog: true, logger: silentServeLogger(),
    });
    stops.push(r);

    // serve wrote the discovery pointer; discovery probes the family the
    // server actually bound (explicit IP, not the pointer's `localhost`).
    const found = await discoverServe(cwd);
    expect(found).not.toBeNull();
    expect(found!.source).toContain('pointer');
    expect(found!.mcpUrl).toMatch(new RegExp(`^http://(127\\.0\\.0\\.1|\\[::1\\]):${r.handle.port}/__pyric/mcp$`));
    // the pointer carries the server's identity, and discovery pins it
    expect(found!.instanceId).toBeTruthy();
  }, 30_000);

  it('ignores a stale pointer (points at a dead port) and finds nothing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pyric-stale-'));
    mkdirSync(join(cwd, '.pyric'), { recursive: true });
    writeFileSync(
      join(cwd, '.pyric', 'serve.json'),
      JSON.stringify({ url: 'http://localhost:59999', mcpUrl: 'http://localhost:59999/__pyric/mcp', port: 59999 }),
    );
    // nothing on :59999, and (empty scan set) no environment fallback
    expect(await discoverServe(cwd, undefined, noScan)).toBeNull();
  });

  it('matches/rejects a pointer instanceId against the live server', async () => {
    const cwd = project();
    const r = await startServe({
      cwd, port: 0, cacheRoot: join(cwd, '.cache'),
      bridge: true, disableAuditLog: true, logger: silentServeLogger(),
    });
    stops.push(r);
    const pointer = join(cwd, '.pyric', 'serve.json');
    const real = JSON.parse(readFileSync(pointer, 'utf8'));

    // (a) a DIFFERENT instanceId (a cross-family squatter) is rejected, and we
    // do NOT blind-scan into a possibly-wrong server.
    writeFileSync(pointer, JSON.stringify({ ...real, instanceId: 'not-the-real-one' }));
    expect(await discoverServe(cwd, undefined, noScan)).toBeNull();

    // (b) back-compat: an OLDER pointer with no instanceId still resolves via
    // the pointer (matching is skipped when the pointer carries no identity).
    const noId = { ...real };
    delete noId.instanceId;
    writeFileSync(pointer, JSON.stringify(noId));
    const found = await discoverServe(cwd, undefined, noScan);
    expect(found).not.toBeNull();
    expect(found!.source).toContain('pointer');
  }, 30_000);
});
