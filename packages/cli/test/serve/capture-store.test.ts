/** Unit tests for `createCaptureStore` — the write-side of the pyric verify loop. */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCaptureStore, CAPTURE_RELATIVE_PATH, ensureGitignored } from '../../src/serve/capture-store.js';

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

  it('read returns null before any write, then the verbatim body after', () => {
    const dir = tmp();
    try {
      const store = createCaptureStore(dir);
      // Nothing captured yet → null (GET /__pyric/capture 404s → boot skips).
      expect(store.read()).toBeNull();
      const body = JSON.stringify({ schema: 'pyric.verify.fixture.v1', events: [{ id: 'e1' }], services: {} });
      store.write(body);
      expect(store.read()).toBe(body);
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

  it("a write adds .pyric/ to the app's .gitignore, creating it when absent", () => {
    const dir = tmp();
    try {
      createCaptureStore(dir).write('{}');
      const lines = readFileSync(join(dir, '.gitignore'), 'utf8').split('\n');
      expect(lines).toContain('.pyric/');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a write appends .pyric/ to an existing .gitignore once, keeping its lines', () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, '.gitignore'), 'node_modules');
      const store = createCaptureStore(dir);
      store.write('{}');
      store.write('{}');
      createCaptureStore(dir).write('{}');
      const lines = readFileSync(join(dir, '.gitignore'), 'utf8').split('\n').filter(Boolean);
      expect(lines).toEqual(['node_modules', '.pyric/']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a .gitignore that already ignores .pyric is left as it is', () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, '.gitignore'), 'dist\n/.pyric\n');
      createCaptureStore(dir).write('{}');
      expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('dist\n/.pyric\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ensureGitignored', () => {
  it('appends .pyric/ once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-gitignore-'));
    try {
      writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
      ensureGitignored(dir);
      ensureGitignored(dir);
      expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules/\n.pyric/\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
