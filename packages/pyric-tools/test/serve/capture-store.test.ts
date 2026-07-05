/** Unit tests for `createCaptureStore` — the write-side of the pyric verify loop. */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCaptureStore, CAPTURE_RELATIVE_PATH } from '../../src/serve/capture-store.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'pyric-capture-'));

describe('createCaptureStore', () => {
  it('write creates .pyric/last-session.json with the verbatim body', () => {
    const dir = tmp();
    try {
      const store = createCaptureStore(dir);
      expect(store.path).toBe(join(dir, CAPTURE_RELATIVE_PATH));

      const body = JSON.stringify({ rules: 'rules_version = "2";', events: [], state: {} });
      store.write(body);

      expect(existsSync(store.path)).toBe(true);
      expect(readFileSync(store.path, 'utf8')).toBe(body);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips a fixture JSON blob verbatim (no re-serialization)', () => {
    const dir = tmp();
    try {
      const store = createCaptureStore(dir);
      const fixture = {
        description: 'test session',
        rules: 'rules_version = "2"; service cloud.firestore { match /databases/{db}/documents { match /{doc} { allow read; } } }',
        events: [{ kind: 'write', path: 'tasks/a', data: { title: 'hello' } }],
        state: { 'tasks/a': { title: 'hello' } },
      };
      const body = JSON.stringify(fixture);
      store.write(body);

      const read = JSON.parse(readFileSync(store.path, 'utf8')) as typeof fixture;
      expect(read.description).toBe(fixture.description);
      expect(read.rules).toBe(fixture.rules);
      expect(read.events).toEqual(fixture.events);
      expect(read.state).toEqual(fixture.state);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the .pyric directory if absent', () => {
    const dir = tmp();
    try {
      // The temp dir exists but .pyric/ does not — write must create it.
      const store = createCaptureStore(dir);
      expect(existsSync(join(dir, '.pyric'))).toBe(false);
      store.write('{}');
      expect(existsSync(join(dir, '.pyric'))).toBe(true);
      expect(existsSync(store.path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('overwrites on subsequent writes (last write wins)', () => {
    const dir = tmp();
    try {
      const store = createCaptureStore(dir);
      store.write(JSON.stringify({ rules: '', events: [], state: { 'a/b': { x: 1 } } }));
      store.write(JSON.stringify({ rules: '', events: [], state: { 'a/b': { x: 2 } } }));
      const parsed = JSON.parse(readFileSync(store.path, 'utf8')) as { state: { 'a/b': { x: number } } };
      expect(parsed.state['a/b'].x).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
