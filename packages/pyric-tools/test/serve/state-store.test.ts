/** State store for `--persist` (pyric-persist plan 1.1). */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createStateStore,
  StateFileError,
  STATE_RELATIVE_PATH,
} from '../../src/serve/state-store.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'pyric-state-'));

describe('createStateStore', () => {
  it('round-trips sections; absent file loads as null', () => {
    const dir = tmp();
    const store = createStateStore(dir);
    expect(store.load()).toBeNull();
    expect(store.readSection('firestore')).toBeNull();

    const blob = { version: 1, savedAt: 123, firestore: { 'posts/a': { title: 'x' } } };
    store.writeSection('firestore', blob);
    store.writeSection('auth', { users: [{ uid: 'u1', email: 'a@x.com', password: 'pw' }] });

    expect(store.readSection('firestore')).toEqual(blob); // verbatim, never re-encoded
    const env = store.load()!;
    expect(env.version).toBe(1);
    expect((env.auth as { users: unknown[] }).users).toHaveLength(1);
    expect(store.path).toBe(join(dir, STATE_RELATIVE_PATH));
    // human-readable on disk (pretty-printed JSON)
    expect(readFileSync(store.path, 'utf8')).toContain('"posts/a"');
  });

  it('writes are atomic: no tmp file left behind, file always parseable', () => {
    const dir = tmp();
    const store = createStateStore(dir);
    for (let i = 0; i < 5; i++) store.writeSection('firestore', { i });
    const files = readdirSync(dirname(store.path));
    expect(files).toEqual(['state.json']); // no .tmp-* residue
    expect(JSON.parse(readFileSync(store.path, 'utf8')).firestore).toEqual({ i: 4 });
  });

  it('backs up to .bak before a firestore write collapses non-empty → empty', () => {
    const dir = tmp();
    const store = createStateStore(dir);
    const full = { version: 1, savedAt: 1, firestore: { 'posts/a': { t: 1 }, 'posts/b': { t: 2 } } };
    store.writeSection('firestore', full);
    expect(existsSync(store.backupPath)).toBe(false); // first write, nothing to back up

    // a reset-style empty flush
    store.writeSection('firestore', { version: 1, savedAt: 2, firestore: {} });
    expect(existsSync(store.backupPath)).toBe(true);
    const bak = JSON.parse(readFileSync(store.backupPath, 'utf8'));
    expect(bak.firestore.firestore).toEqual(full.firestore); // recoverable
    // primary is now empty (the live truth), but recovery exists
    expect(JSON.parse(readFileSync(store.path, 'utf8')).firestore.firestore).toEqual({});

    // a normal non-empty → non-empty write does NOT churn the backup
    const before = readFileSync(store.backupPath, 'utf8');
    store.writeSection('firestore', { version: 1, savedAt: 3, firestore: { 'posts/c': { t: 3 } } });
    expect(readFileSync(store.backupPath, 'utf8')).toBe(before); // untouched
  });

  it('fails fast on an inner controller-blob version mismatch (pyric upgrade)', () => {
    const dir = tmp();
    const store = createStateStore(dir);
    // a fresh-enough envelope, but the controller blob is from a newer pyric
    store.writeSection('firestore', { version: 2, savedAt: 1, firestore: { 'a/b': {} } });
    expect(() => store.load()).toThrow(/firestore blob of version 2/);
    // a blob with no inner version (e.g. null section) loads fine
    const ok = createStateStore(tmp());
    ok.writeSection('auth', { users: [] });
    expect(() => ok.load()).not.toThrow();
  });

  it('fails fast (no silent loss) on corrupt JSON and version mismatch', () => {
    const dir = tmp();
    const store = createStateStore(dir);
    mkdirSync(dirname(store.path), { recursive: true });
    writeFileSync(store.path, '{ not json');
    expect(() => store.load()).toThrow(StateFileError);
    expect(() => store.readSection('auth')).toThrow(/not valid JSON/);

    writeFileSync(store.path, JSON.stringify({ version: 99, firestore: null, auth: null }));
    expect(() => store.load()).toThrow(/version 99/);
    // and a corrupt file is never clobbered by a section write
    expect(() => store.writeSection('firestore', {})).toThrow(StateFileError);
    expect(readFileSync(store.path, 'utf8')).toContain('99');
  });
});
