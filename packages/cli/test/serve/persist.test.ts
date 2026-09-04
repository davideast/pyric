/** `--persist` end-to-end over HTTP (pyric-persist plan 1.4) — the state
 *  channel + precedence, server-side. The in-browser controller loop is the
 *  1.5 browser gate. */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveJsonLine, startServe, type ServeRuntime } from '../../src/cli/serve.js';
import { silentServeLogger } from '../../src/serve/server.js';
import { createStateStore, STATE_RELATIVE_PATH } from '../../src/serve/state-store.js';

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-persist-proj-'));
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ hosting: { public: 'public' } }));
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'public', 'index.html'), '<!doctype html><html><head></head><body>p</body></html>');
  writeFileSync(join(dir, 'seed.json'), JSON.stringify({ 'posts/seeded': { title: 's' } }));
  return dir;
}

const stops: ServeRuntime[] = [];
afterAll(async () => {
  for (const r of stops) await r.handle.stop();
});

const tokens = new WeakMap<ServeRuntime, string>();

async function serve(cwd: string, persist = true): Promise<ServeRuntime> {
  const r = await startServe({
    cwd,
    port: 0,
    cacheRoot: join(cwd, '.cache'),
    seed: 'seed.json',
    persist,
    logger: silentServeLogger(),
  });
  stops.push(r);
  const init = (await (await fetch(`${r.handle.url}/__pyric/init.json`)).json()) as { sessionToken: string };
  tokens.set(r, init.sessionToken);
  return r;
}

// What the page's persistence controller would write (its own blob shape).
const BLOB = { version: 1, savedAt: 42, firestore: { 'posts/lived': { title: 'lived' } } };

function authHeaders(r: ServeRuntime, extra: Record<string, string> = {}): Record<string, string> {
  const token = tokens.get(r);
  return {
    ...(token ? { 'x-pyric-session-token': token } : {}),
    ...extra,
  };
}

describe('pyric dev --persist', () => {
  it('first run: seed applies, channel round-trips, file lands atomically', async () => {
    const cwd = project();
    const r = await serve(cwd);
    const base = r.handle.url;

    // first (state-less) run: seed flows, persist flagged, no users yet
    const p1 = r.payload();
    expect(p1.persist).toBe(true);
    expect(p1.seed).toEqual({ 'posts/seeded': { title: 's' } });
    expect(p1.authUsers).toBeNull();

    // nothing persisted yet
    expect((await fetch(`${base}/__pyric/state?section=firestore`, { headers: authHeaders(r) })).status).toBe(404);

    // the page's controller flushes its blob; auth section flushes users
    const post = await fetch(`${base}/__pyric/state?section=firestore`, {
      method: 'POST',
      headers: authHeaders(r, { 'content-type': 'application/json' }),
      body: JSON.stringify(BLOB),
    });
    expect(post.status).toBe(204);
    await fetch(`${base}/__pyric/state?section=auth`, {
      method: 'POST',
      headers: authHeaders(r, { 'content-type': 'application/json' }),
      body: JSON.stringify({ users: [{ uid: 'u1', email: 'a@x.com', password: 'pw' }] }),
    });

    // round-trip: GET returns the blob verbatim; whole envelope for promote
    expect(await (await fetch(`${base}/__pyric/state?section=firestore`, { headers: authHeaders(r) })).json()).toEqual(BLOB);
    const envelope = (await (await fetch(`${base}/__pyric/state`, { headers: authHeaders(r) })).json()) as Record<string, unknown>;
    expect(envelope.version).toBe(1);
    expect((envelope.auth as { users: unknown[] }).users).toHaveLength(1);

    // on disk: pretty JSON at the documented path
    const onDisk = readFileSync(join(cwd, STATE_RELATIVE_PATH), 'utf8');
    expect(onDisk).toContain('"posts/lived"');

    // NOW the state file exists → the live payload already drops the seed
    expect(r.payload().seed).toBeNull();
    await r.handle.stop();
    stops.pop();
  }, 30_000);

  it('restart: state wins — seed skipped, users delivered in the payload', async () => {
    const cwd = project();
    const r1 = await serve(cwd);
    await fetch(`${r1.handle.url}/__pyric/state?section=firestore`, {
      method: 'POST', headers: authHeaders(r1, { 'content-type': 'application/json' }), body: JSON.stringify(BLOB),
    });
    await fetch(`${r1.handle.url}/__pyric/state?section=auth`, {
      method: 'POST', headers: authHeaders(r1, { 'content-type': 'application/json' }),
      body: JSON.stringify({ users: [{ uid: 'u1', email: 'a@x.com', password: 'pw' }] }),
    });
    await r1.handle.stop();
    stops.pop();

    const r2 = await serve(cwd);
    const p = r2.payload();
    expect(p.seed).toBeNull();
    expect(p.authUsers).toEqual([{ uid: 'u1', email: 'a@x.com', password: 'pw' }]);
    expect(await (await fetch(`${r2.handle.url}/__pyric/state?section=firestore`, { headers: authHeaders(r2) })).json()).toEqual(BLOB);
  }, 30_000);

  it('fails fast on a corrupt state file; bad section is 400; persist-off has no route', async () => {
    const cwd = project();
    const statePath = join(cwd, STATE_RELATIVE_PATH);
    mkdirSync(join(cwd, '.pyric', 'state'), { recursive: true });
    writeFileSync(statePath, '{ nope');
    // startServe rejects before serve() pushes — nothing to clean up
    await expect(serve(cwd)).rejects.toThrow(/not valid JSON/);

    writeFileSync(statePath, JSON.stringify({ version: 1, firestore: null, auth: null }));
    const r = await serve(cwd);
    expect((await fetch(`${r.handle.url}/__pyric/state?section=nope`, { method: 'POST', headers: authHeaders(r), body: '{}' })).status).toBe(400);

    const off = await serve(project(), false);
    expect(off.payload().persist).toBe(false);
    expect((await fetch(`${off.handle.url}/__pyric/state`, { headers: authHeaders(off) })).status).toBe(404);
  }, 30_000);

  it('serveJsonLine exposes persist + restore counts; --fresh re-seeds', async () => {
    const cwd = project();
    const store = createStateStore(cwd);
    store.writeSection('firestore', BLOB);
    store.writeSection('auth', { users: [{ uid: 'u1', email: 'a@x.com', password: 'pw' }] });

    // restored run: json line carries persist:true + counts
    const r1 = await serve(cwd);
    const line = JSON.parse(serveJsonLine(r1)) as Record<string, unknown>;
    expect(line.persist).toBe(true);
    expect(line.restoredDocs).toBe(1);
    expect(line.restoredUsers).toBe(1);
    await r1.handle.stop();
    stops.pop();

    // --fresh: discards the state file → first-run, seed applies, 0 restored
    const r2 = await startServe({
      cwd, port: 0, cacheRoot: join(cwd, '.cache'), seed: 'seed.json',
      persist: true, fresh: true, logger: silentServeLogger(),
    });
    stops.push(r2);
    const initR2 = (await (await fetch(`${r2.handle.url}/__pyric/init.json`)).json()) as { sessionToken: string };
    tokens.set(r2, initR2.sessionToken);
    expect(JSON.parse(serveJsonLine(r2)).restoredDocs).toBe(0);
    expect(r2.payload().seed).toEqual({ 'posts/seeded': { title: 's' } }); // seed back in play
    expect((await fetch(`${r2.handle.url}/__pyric/state?section=firestore`, { headers: authHeaders(r2) })).status).toBe(404); // wiped

    // persist OFF → json line says persist:false
    const off = await serve(project(), false);
    expect(JSON.parse(serveJsonLine(off)).persist).toBe(false);
  }, 30_000);

  it('single-writer lock: second writer gets 423; reads stay open; release frees it', async () => {
    const cwd = project();
    const r = await serve(cwd);
    const base = r.handle.url;
    const post = (writer: string) =>
      fetch(`${base}/__pyric/state?section=firestore`, {
        method: 'POST',
        headers: authHeaders(r, { 'content-type': 'application/json', 'x-pyric-writer': writer }),
        body: JSON.stringify(BLOB),
      });

    expect((await post('tab-A')).status).toBe(204); // A claims the lock
    expect((await post('tab-B')).status).toBe(423); // B refused — can't clobber A
    expect((await post('tab-A')).status).toBe(204); // A keeps writing
    // reads are always allowed (a read-only tab still restores)
    expect((await fetch(`${base}/__pyric/state?section=firestore`, { headers: authHeaders(r) })).status).toBe(200);
    // PUT heartbeat refreshes A, still refuses B
    expect((await fetch(`${base}/__pyric/state`, { method: 'PUT', headers: authHeaders(r, { 'x-pyric-writer': 'tab-A' }) })).status).toBe(204);
    expect((await fetch(`${base}/__pyric/state`, { method: 'PUT', headers: authHeaders(r, { 'x-pyric-writer': 'tab-B' }) })).status).toBe(423);
    // A releases (pagehide beacon) → B can take over
    await fetch(`${base}/__pyric/state`, { method: 'DELETE', headers: authHeaders(r, { 'x-pyric-writer': 'tab-A' }) });
    expect((await post('tab-B')).status).toBe(204);
  }, 30_000);
});

describe('pyric dev --fresh guardrails', () => {
  it('--fresh without --persist errors instead of silently no-opping', async () => {
    const cwd = project();
    await expect(
      startServe({ cwd, port: 0, cacheRoot: join(cwd, '.cache'), fresh: true, logger: silentServeLogger() }),
    ).rejects.toThrow(/--fresh requires --persist/);
  });

  it('--persist --fresh is fine (the escape hatch works)', async () => {
    const cwd = project();
    const r = await startServe({
      cwd, port: 0, cacheRoot: join(cwd, '.cache'), persist: true, fresh: true, logger: silentServeLogger(),
    });
    stops.push(r);
    expect(r.persist).toEqual({ restoredDocs: 0, restoredUsers: 0 });
  }, 30_000);
});
