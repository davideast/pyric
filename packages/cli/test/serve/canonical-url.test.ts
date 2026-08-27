/**
 * Canonical URL pinning — ONE origin everywhere for the default host.
 *
 * `pyric dev` binds BOTH loopback families for the default `localhost` host,
 * but to a browser `http://localhost:<port>` and `http://127.0.0.1:<port>` are
 * DIFFERENT ORIGINS — different SharedWorkers, so different sandboxes. Every
 * user-facing and machine-facing URL must therefore agree on the ONE canonical
 * origin the banner/auto-open use:
 *
 *   banner + auto-open      → handle.url
 *   `--json` machine line   → serveJsonLine(runtime).url
 *   .pyric/serve.json       → pointer url / mcpUrl
 *   runner env              → PYRIC_SANDBOX=remote:<handle.url>
 *   discovery guidance      → discoverServe(cwd).url ("open <url>" strings)
 *
 * A user following any of them must land on the SAME origin. Literal loopback
 * addresses stay where they belong: connectivity (`Discovered.base`, the
 * health probes) — never identity.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServe, serveJsonLine, type ServeRuntime } from '../../src/cli/serve.js';
import { buildChildEnv } from '../../src/cli/sandbox-runner.js';
import { silentServeLogger } from '../../src/serve/server.js';
import { discoverServe, canonicalServeUrl } from '../../src/serve/discovery.js';

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-canon-'));
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ hosting: { public: 'public' } }));
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'public', 'index.html'), '<!doctype html><html><head></head><body>c</body></html>');
  return dir;
}

const stops: ServeRuntime[] = [];
afterAll(async () => {
  for (const r of stops) await r.handle.stop();
});

describe('canonical serve URL (default host)', () => {
  it('banner/auto-open, --json, serve.json, runner env, and discovery guidance all share the localhost origin', async () => {
    const cwd = project();
    const r = await startServe({
      cwd, port: 0, cacheRoot: join(cwd, '.cache'),
      bridge: true, disableAuditLog: true, logger: silentServeLogger(),
    });
    stops.push(r);

    // The banner (`Local server:`) and auto-open both print handle.url.
    const bannerHost = new URL(r.handle.url).hostname;
    expect(bannerHost).toBe('localhost');

    // The --json machine line agents parse.
    const json = JSON.parse(serveJsonLine(r)) as { url: string; mcpUrl: string | null };
    expect(new URL(json.url).hostname).toBe(bannerHost);
    expect(new URL(json.mcpUrl!).hostname).toBe(bannerHost);

    // The .pyric/serve.json discovery pointer.
    const pointer = JSON.parse(readFileSync(join(cwd, '.pyric', 'serve.json'), 'utf8')) as {
      url: string;
      mcpUrl: string;
    };
    expect(new URL(pointer.url).hostname).toBe(bannerHost);
    expect(new URL(pointer.mcpUrl).hostname).toBe(bannerHost);

    // The runner env (`PYRIC_SANDBOX=remote:<serve url>`) — the activator the
    // child's `@pyric/cli/register` reads.
    const env = buildChildEnv({}, { serveUrl: r.handle.url, registerUrl: 'file:///register.js' });
    const activated = env.PYRIC_SANDBOX!.replace(/^remote:/, '');
    expect(new URL(activated).hostname).toBe(bannerHost);

    // Discovery: `url` (the "open <url>" guidance origin) is canonical and
    // EQUALS the banner origin; `base` stays a literal family (connectivity).
    const found = await discoverServe(cwd);
    expect(found).not.toBeNull();
    expect(found!.url).toBe(r.handle.url);
    expect(found!.base).toMatch(/^http:\/\/(127\.0\.0\.1|\[::1\]):\d+$/);
  }, 30_000);

  it('an explicit --host is the canon for every consumer', async () => {
    const cwd = project();
    const r = await startServe({
      cwd, port: 0, host: '127.0.0.1', cacheRoot: join(cwd, '.cache'),
      bridge: true, disableAuditLog: true, logger: silentServeLogger(),
    });
    stops.push(r);

    expect(new URL(r.handle.url).hostname).toBe('127.0.0.1');
    const pointer = JSON.parse(readFileSync(join(cwd, '.pyric', 'serve.json'), 'utf8')) as { url: string };
    expect(new URL(pointer.url).hostname).toBe('127.0.0.1');

    // Discovery honors the pointer's explicit host as the display URL.
    const found = await discoverServe(cwd);
    expect(found).not.toBeNull();
    expect(found!.url).toBe(r.handle.url);
  }, 30_000);
});

describe('canonicalServeUrl', () => {
  it('prefers the pointer url origin, falls back to localhost', () => {
    expect(canonicalServeUrl(3473, 'http://localhost:3473')).toBe('http://localhost:3473');
    expect(canonicalServeUrl(3473, 'http://127.0.0.1:3473')).toBe('http://127.0.0.1:3473');
    expect(canonicalServeUrl(3473, 'not a url')).toBe('http://localhost:3473');
    expect(canonicalServeUrl(3473)).toBe('http://localhost:3473');
  });
});
