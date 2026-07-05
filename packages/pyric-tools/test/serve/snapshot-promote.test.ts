/** `pyric snapshot` + state-file `--seed` round-trip (pyric-persist 3.1/3.2). */
import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSnapshot } from '../../src/cli/snapshot.js';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import { silentServeLogger } from '../../src/serve/server.js';
import { createStateStore, type PyricStateFile } from '../../src/serve/state-store.js';
import type { ParsedArgs } from '../../src/cli/parse-args.js';

const args = (flags: Record<string, string | boolean> = {}): ParsedArgs => ({
  subcommand: 'snapshot',
  flags: new Map(Object.entries(flags)),
  positional: [],
});

function capture() {
  let outBuf = '';
  let errBuf = '';
  return {
    io: (cwd: string) => ({
      cwd,
      stdout: { write: (s: string) => void (outBuf += s) },
      stderr: { write: (s: string) => void (errBuf += s) },
    }),
    out: () => outBuf,
    err: () => errBuf,
  };
}

const BLOB = { version: 1, savedAt: 7, firestore: { 'posts/a': { title: 'x' }, 'posts/b': { title: 'y' } } };
const USERS = [{ uid: 'u1', email: 'a@x.com', password: 'pw' }];

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-snap-'));
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ hosting: { public: 'public' } }));
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'public', 'index.html'), '<!doctype html><html><head></head><body>s</body></html>');
  return dir;
}

const stops: ServeRuntime[] = [];
afterAll(async () => {
  for (const r of stops) await r.handle.stop();
});

describe('pyric snapshot', () => {
  it('promotes the on-disk state file; --json contract; --force gate', async () => {
    const cwd = project();
    const store = createStateStore(cwd);
    store.writeSection('firestore', BLOB);
    store.writeSection('auth', { users: USERS });

    const c = capture();
    const noLive = async () => null;
    expect(await runSnapshot(args({ json: true }), { ...c.io(cwd), fetchLive: noLive })).toBe(0);
    const machine = JSON.parse(c.out()) as { out: string; docs: number; users: number; source: string };
    expect(machine.docs).toBe(2);
    expect(machine.users).toBe(1);
    expect(machine.source).toContain('state.json');
    const fixture = JSON.parse(readFileSync(machine.out, 'utf8')) as PyricStateFile;
    // the envelope IS the fixture — minus `savedAt` (stripped so committed
    // fixtures don't re-diff on every promote)
    const { savedAt: _s, ...blobSansSavedAt } = BLOB as Record<string, unknown>;
    expect(fixture.firestore).toEqual(blobSansSavedAt);
    expect(c.err()).toContain('Re-serve it');

    // passwords were REDACTED by default (the fixture is meant to be committed)
    const promoted = JSON.parse(readFileSync(machine.out, 'utf8')) as PyricStateFile;
    expect(promoted.auth!.users[0]!.password).toBe('__pyric_no_password__');
    expect((JSON.parse(c.out()) as { redactedPasswords: number }).redactedPasswords).toBe(1);
    expect(c.err()).toContain('redacted 1 password');

    // refuses to overwrite without --force
    const c2 = capture();
    expect(await runSnapshot(args(), { ...c2.io(cwd), fetchLive: noLive })).toBe(2);
    expect(c2.err()).toContain('--force');

    // --include-passwords keeps the real secret
    const c3 = capture();
    expect(await runSnapshot(args({ force: true, 'include-passwords': true }), { ...c3.io(cwd), fetchLive: noLive })).toBe(0);
    const kept = JSON.parse(readFileSync(join(cwd, 'pyric-state.json'), 'utf8')) as PyricStateFile;
    expect(kept.auth!.users[0]!.password).toBe('pw');
  });

  it('prefers LIVE state from a running serve --persist', async () => {
    const cwd = project();
    const r = await startServe({ cwd, port: 0, cacheRoot: join(cwd, '.cache'), persist: true, logger: silentServeLogger() });
    stops.push(r);
    await fetch(`${r.handle.url}/__pyric/state?section=firestore`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(BLOB),
    });

    const c = capture();
    expect(await runSnapshot(args({ json: true, port: String(r.handle.port) }), c.io(cwd))).toBe(0);
    const machine = JSON.parse(c.out()) as { docs: number; source: string };
    expect(machine.docs).toBe(2);
    expect(machine.source).toContain(`port ${r.handle.port}`);
  }, 30_000);

  it('exits 2 with guidance when no state exists anywhere', async () => {
    const c = capture();
    expect(await runSnapshot(args(), { ...c.io(project()), fetchLive: async () => null })).toBe(2);
    expect(c.err()).toContain('--persist');
  });
});

describe('--seed accepts the state-file shape (3.2)', () => {
  it('ephemeral: fixture flows as seedState + authUsers, not seed', async () => {
    const cwd = project();
    writeFileSync(
      join(cwd, 'fixture.json'),
      JSON.stringify({ version: 1, firestore: BLOB, auth: { users: USERS } }),
    );
    const r = await startServe({ cwd, port: 0, cacheRoot: join(cwd, '.cache'), seed: 'fixture.json', logger: silentServeLogger() });
    stops.push(r);
    const p = r.payload();
    expect(p.seed).toBeNull();
    expect(p.seedState).toEqual(BLOB);
    expect(p.authUsers).toEqual(USERS);
    expect(p.persist).toBe(false);
  }, 30_000);

  it('persist first run: fixture primes the state store', async () => {
    const cwd = project();
    writeFileSync(
      join(cwd, 'fixture.json'),
      JSON.stringify({ version: 1, firestore: BLOB, auth: { users: USERS } }),
    );
    const r = await startServe({ cwd, port: 0, cacheRoot: join(cwd, '.cache'), seed: 'fixture.json', persist: true, logger: silentServeLogger() });
    stops.push(r);
    expect(existsSync(join(cwd, '.pyric', 'state', 'state.json'))).toBe(true);
    const p = r.payload();
    expect(p.persist).toBe(true);
    expect(p.authUsers).toEqual(USERS); // delivered from the primed store
    expect(p.seedState).toBeNull();
    // the page's controller will GET the primed firestore section
    expect(await (await fetch(`${r.handle.url}/__pyric/state?section=firestore`)).json()).toEqual(BLOB);
  }, 30_000);
});
