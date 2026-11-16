/**
 * Tests for hosted `createHostedStateView` auth section round-trip preservation.
 *
 * Ensures both `load()` (`GET /__pyric/state`) and `readSection('auth')`
 * (`GET /__pyric/state?section=auth`) preserve `auth.providers`, `auth.history`,
 * and other persisted auth fields alongside `auth.users`.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';
import { createHostedStateView } from '../../../src/serve/hosted/persistence/state-view.js';

type HostedDatabase = Awaited<ReturnType<typeof openHostedDatabase>>;

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** Minimal in-memory test double for `openHostedDatabase` covering record + state-view operations. */
function createMemoryHostedDatabase(): HostedDatabase {
  const records = new Map<string, Map<string, unknown>>();
  const bucketFor = (namespace: string): Map<string, unknown> => {
    let ns = records.get(namespace);
    if (ns === undefined) {
      ns = new Map<string, unknown>();
      records.set(namespace, ns);
    }
    return ns;
  };
  const emptyStatement = {
    run: () => undefined,
    get: () => undefined,
    all: () => [],
  };
  const db = {
    connection: {
      exec: () => {},
      prepare: () => emptyStatement,
      close: () => {},
    },
    objects: {
      size: () => undefined,
      path: (hash: string) => hash,
    },
    schemaVersion: () => 6,
    readRecord(namespace: string, id: string): unknown | null {
      const val = bucketFor(namespace).get(id);
      return val === undefined ? null : structuredClone(val);
    },
    hasRecords(namespace: string): boolean {
      return bucketFor(namespace).size > 0;
    },
    readRecords(namespace: string): Map<string, unknown> {
      const out = new Map<string, unknown>();
      for (const [id, val] of bucketFor(namespace)) out.set(id, structuredClone(val));
      return out;
    },
    commitChanges(
      namespace: string,
      changed: ReadonlyMap<string, unknown>,
      removed: readonly string[],
    ): void {
      const ns = bucketFor(namespace);
      for (const [id, val] of changed) ns.set(id, structuredClone(val));
      for (const id of removed) ns.delete(id);
    },
    storage: {
      async mutate<T>(work: (writes: unknown) => T): Promise<T> {
        return work({});
      },
    },
  };
  return db as unknown as HostedDatabase;
}

describe('createHostedStateView auth preservation', () => {
  it('preserves providers and history on load() and readSection("auth")', async () => {
    const dir = makeTempDir('pyric-state-view-auth-');
    const db = createMemoryHostedDatabase();
    const view = createHostedStateView(dir, join(dir, '.pyric', 'hosted'), db, 'default');

    const authPayload = {
      users: [
        {
          uid: 'user-1',
          email: 'user-1@example.test',
          password: 'password-123',
        },
      ],
      providers: {
        password: true,
        anonymous: false,
        'google.com': true,
      },
      history: {
        tokensValidAfterMs: { 'user-1': 1_700_000_000_000 },
        deletedUids: ['user-deleted'],
      },
    };

    await view.writeSection('auth', authPayload);

    const section = view.readSection('auth') as Record<string, unknown> | null;
    expect(section).not.toBeNull();
    expect(section?.providers).toEqual(authPayload.providers);
    expect(section?.history).toEqual(authPayload.history);
    expect(Array.isArray(section?.users)).toBe(true);
    expect((section?.users as Array<{ uid: string }>).map((u) => u.uid)).toEqual(['user-1']);

    const full = view.load();
    expect(full).not.toBeNull();
    const fullAuth = full?.auth as Record<string, unknown> | null | undefined;
    expect(fullAuth?.providers).toEqual(authPayload.providers);
    expect(fullAuth?.history).toEqual(authPayload.history);
    expect((fullAuth?.users as Array<{ uid: string }>).map((u) => u.uid)).toEqual(['user-1']);
  });

  it('round-trips auth providers and history through real Node SQLite hosted persistence', async () => {
    const dir = makeTempDir('pyric-state-view-node-');
    symlinkSync(
      new URL('../../../../node_modules', import.meta.url).pathname,
      join(dir, 'node_modules'),
      'dir',
    );
    const distUrl = new URL('../../../dist/serve/hosted/persistence/', import.meta.url).href;
    const scriptPath = join(dir, 'check.mjs');
    const script = [
      `import { openHostedDatabase } from '${distUrl}database.js';`,
      `import { createHostedStateView } from '${distUrl}state-view.js';`,
      `import assert from 'node:assert/strict';`,
      `const projectDir = process.argv[2];`,
      `const stateDir = projectDir + '/state';`,
      `const db = await openHostedDatabase(stateDir);`,
      `try {`,
      `  const view = createHostedStateView(projectDir, stateDir, db, 'hosted');`,
      `  await view.seed({`,
      `    version: 1,`,
      `    firestore: null,`,
      `    auth: {`,
      `      users: [{ uid: 'u1', email: 'u1@example.test', password: 'secret-password' }],`,
      `      providers: { password: true, anonymous: true },`,
      `      history: { tokensValidAfterMs: { u1: 1700000001000 }, deletedUids: ['u0'] },`,
      `    },`,
      `    storage: [],`,
      `  });`,
      `  const full = view.load();`,
      `  const section = view.readSection('auth');`,
      `  assert.deepEqual(full.auth.providers, { password: true, anonymous: true });`,
      `  assert.deepEqual(full.auth.history, { tokensValidAfterMs: { u1: 1700000001000 }, deletedUids: ['u0'] });`,
      `  assert.deepEqual(section.providers, { password: true, anonymous: true });`,
      `  assert.deepEqual(section.history, { tokensValidAfterMs: { u1: 1700000001000 }, deletedUids: ['u0'] });`,
      `  console.log('OK');`,
      `} finally {`,
      `  db.close();`,
      `}`,
    ].join('\n');
    writeFileSync(scriptPath, script);

    const result = spawnSync(process.env.PYRIC_TEST_NODE ?? 'node', [scriptPath, dir], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    if (result.status !== 0) {
      throw new Error(`Node SQLite auth state-view check failed (${result.status}): ${result.stderr}`);
    }
    expect(result.stdout.trim()).toBe('OK');
  });
});
