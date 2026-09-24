/** `pyric snapshot` + state-file `--seed` round-trip (pyric-persist 3.1/3.2). */
import { afterAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
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
const BYTES = new TextEncoder().encode('recorded take');
const SHA256 = createHash('sha256').update(BYTES).digest('hex');
const OBJECT_METADATA = {
  bucket: 'pyric-default', fullPath: 'media/take.wav', name: 'take.wav', size: BYTES.byteLength, generation: '1', metageneration: '1',
  timeCreated: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', contentType: 'audio/wav',
};
const REFERENCE = { path: 'media/take.wav', sha256: SHA256, size: BYTES.byteLength, blobType: 'audio/wav', metadata: OBJECT_METADATA };
const INLINE = { dataBase64: Buffer.from(BYTES).toString('base64'), blobType: 'audio/wav', metadata: OBJECT_METADATA };

/** Where a snapshot directory keeps an object's bytes. */
const objectIn = (directory: string, sha256: string) => join(directory, 'objects', sha256.slice(0, 2), sha256);

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
  it('fetches each object a live host refers to by hash, into the snapshot directory', async () => {
    const cwd = project();
    const c = capture();
    const requested: string[] = [];
    const live = async () => ({
      envelope: { version: 1 as const, firestore: null, auth: null, storage: [REFERENCE] },
      projectDir: cwd,
      readObject: async (sha256: string) => { requested.push(sha256); return BYTES; },
    });
    expect(await runSnapshot(args(), { ...c.io(cwd), fetchLive: live })).toBe(0);
    expect(requested).toEqual([SHA256]);
    const directory = join(cwd, 'pyric-state');
    expect(JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')).storage).toEqual([REFERENCE]);
    expect(new Uint8Array(readFileSync(objectIn(directory, SHA256)))).toEqual(BYTES);
  });

  it('refuses an object a live host serves with bytes that do not match their hash', async () => {
    const cwd = project();
    const c = capture();
    const live = async () => ({
      envelope: { version: 1 as const, firestore: null, auth: null, storage: [REFERENCE] },
      projectDir: cwd,
      readObject: async () => new TextEncoder().encode('something else'),
    });
    expect(await runSnapshot(args(), { ...c.io(cwd), fetchLive: live })).toBe(2);
    expect(c.err()).toContain('media/take.wav');
    expect(existsSync(join(cwd, 'pyric-state', 'state.json'))).toBe(false);
  });

  it('writes inline objects from the browser store as files beside the document', async () => {
    const cwd = project();
    createStateStore(cwd).writeSection('storage', [INLINE]);
    const c = capture();
    expect(await runSnapshot(args(), { ...c.io(cwd), fetchLive: async () => null })).toBe(0);
    const directory = join(cwd, 'pyric-state');
    expect(JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')).storage).toEqual([REFERENCE]);
    expect(new Uint8Array(readFileSync(objectIn(directory, SHA256)))).toEqual(BYTES);
  });

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
    const fixture = JSON.parse(readFileSync(join(machine.out, 'state.json'), 'utf8')) as PyricStateFile;
    // the envelope IS the fixture — minus `savedAt` (stripped so committed
    // fixtures don't re-diff on every promote)
    const { savedAt: _s, ...blobSansSavedAt } = BLOB as Record<string, unknown>;
    expect(fixture.firestore).toEqual(blobSansSavedAt);
    expect(c.err()).toContain('Re-serve it');

    // passwords were REDACTED by default (the fixture is meant to be committed)
    const promoted = JSON.parse(readFileSync(join(machine.out, 'state.json'), 'utf8')) as PyricStateFile;
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
    const kept = JSON.parse(readFileSync(join(cwd, 'pyric-state', 'state.json'), 'utf8')) as PyricStateFile;
    expect(kept.auth!.users[0]!.password).toBe('pw');
  });

  it('prefers LIVE state from a running dev --persist', async () => {
    const cwd = project();
    const r = await startServe({ cwd, port: 0, cacheRoot: join(cwd, '.cache'), persist: true, logger: silentServeLogger() });
    stops.push(r);
    const init = (await (await fetch(`${r.handle.url}/__pyric/init.json`)).json()) as { sessionToken: string };
    await fetch(`${r.handle.url}/__pyric/state?section=firestore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pyric-session-token': init.sessionToken },
      body: JSON.stringify(BLOB),
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
    const init = (await (await fetch(`${r.handle.url}/__pyric/init.json`)).json()) as { sessionToken: string };
    expect(await (await fetch(`${r.handle.url}/__pyric/state?section=firestore`, {
      headers: { 'x-pyric-session-token': init.sessionToken },
    })).json()).toEqual(BLOB);
  }, 30_000);

  it('persist first run: a snapshot directory primes the store, its objects read back inline', async () => {
    const cwd = project();
    const directory = join(cwd, 'fixture');
    mkdirSync(join(directory, 'objects', SHA256.slice(0, 2)), { recursive: true });
    writeFileSync(objectIn(directory, SHA256), BYTES);
    writeFileSync(join(directory, 'state.json'), JSON.stringify({ version: 1, firestore: BLOB, auth: null, storage: [REFERENCE] }));
    const r = await startServe({ cwd, port: 0, cacheRoot: join(cwd, '.cache'), seed: 'fixture', persist: true, logger: silentServeLogger() });
    stops.push(r);
    expect(createStateStore(cwd).readSection('storage')).toEqual([INLINE]);
  }, 30_000);
});
