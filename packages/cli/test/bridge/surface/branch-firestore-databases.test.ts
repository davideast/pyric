/**
 * Mirror tests for `src/bridge/surface/branch-firestore-databases.ts`:
 * checkpoints (directory + SQLite hosted backend) and branches (`fork`,
 * `apply`, `diff`, `promote`) preserving declared named Firestore databases,
 * rules, and isolated documents alongside `(default)`.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getAdminFirestore,
  getDoc,
  getFirestore,
  setDoc,
  writeBatch,
} from 'pyric/firestore';
import {
  captureNamedFirestoreState,
  declareFirestoreDatabase,
  getDatabaseEnv,
  listDeclaredFirestoreDatabases,
  restoreNamedFirestoreState,
} from 'pyric/firestore/internal';
import { initializeSandbox } from 'pyric/sandbox';
import { getAdminStorageSandbox } from 'pyric/storage/internal';

import {
  createSurfaceContext,
  renderSurface,
  type OperationResult,
} from '../../../src/bridge/surface/index.js';
import { METHODS } from '../../../src/bridge/surface/methods/registry.js';
import { Database } from 'bun:sqlite';
import { createBlobStore } from '../../../src/serve/hosted/persistence/blob-store.js';
import {
  CHECKPOINT_TABLES,
  createHostedCheckpointBackend,
} from '../../../src/serve/hosted/persistence/checkpoints.js';
import type { SqlConnection, SqlRow, SqlValue } from '../../../src/serve/hosted/persistence/sqlite.js';
import { buildVerifyFixture } from '../../../src/verify/index.js';

const REPORTS_OPEN = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth.uid == 'u1';
    }
  }
}`;

const REPORTS_LOCKED = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}`;

const tempDirs: string[] = [];
let nextStorageDb = 0;

function freshSandbox(): ReturnType<typeof initializeSandbox> {
  const sandbox = initializeSandbox();
  getAdminStorageSandbox(sandbox, { dbName: `pyric-branch-fsdb:${nextStorageDb++}` });
  return sandbox;
}

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-branch-fsdb-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function callMethod(
  ctx: ReturnType<typeof createSurfaceContext>,
  surface: ReturnType<typeof renderSurface>,
  key: string,
  args: Record<string, unknown>,
): Promise<OperationResult> {
  const [toolName, methodName] = key.split('.');
  const tool = surface.tools.find((candidate) => candidate.name === toolName);
  if (!tool || !methodName) throw new Error(`Unknown method ${key}`);
  return tool.execute({ method: methodName, args }, ctx);
}

describe('branch-firestore-databases and checkpoints', () => {
  it('saves and restores named Firestore databases across directory and SQLite checkpoint backends', async () => {
    const projectDir = makeDir();
    const surface = renderSurface(undefined);
    const sandbox = freshSandbox();
    const ctx = createSurfaceContext(sandbox, projectDir);

    declareFirestoreDatabase(sandbox, 'reports');
    declareFirestoreDatabase(sandbox, 'empty-audit');
    getDatabaseEnv(sandbox, 'reports').deployRules(REPORTS_OPEN);
    await setDoc(doc(getAdminFirestore(sandbox.withAuth(null)), 'items/shared'), {
      db: 'default',
      n: 1,
    });
    await setDoc(doc(getFirestore(sandbox.withAuth({ uid: 'u1' }), 'reports'), 'items/shared'), {
      db: 'reports',
      n: 2,
    });

    const cpSaved = await callMethod(ctx, surface, 'sandbox.checkpoint', { name: 'snap-1' });
    expect(cpSaved.ok).toBe(true);
    expect((cpSaved.data as { counts: { firestore: number } }).counts.firestore).toBe(2);

    await setDoc(doc(getFirestore(sandbox.withAuth({ uid: 'u1' }), 'reports'), 'items/shared'), {
      db: 'mutated',
      n: 99,
    });
    declareFirestoreDatabase(sandbox, 'extra-temp');

    const cpRestored = await callMethod(ctx, surface, 'sandbox.restore', {
      name: 'snap-1',
      confirm: true,
    });
    expect(cpRestored.ok).toBe(true);
    expect(listDeclaredFirestoreDatabases(sandbox)).toEqual(['empty-audit', 'reports']);
    expect(getDatabaseEnv(sandbox, 'reports').getDocument('items/shared')).toEqual({
      db: 'reports',
      n: 2,
    });
    expect(getDatabaseEnv(sandbox, 'reports').getExplicitRules()).toContain(
      "request.auth.uid == 'u1'",
    );

    const sqliteDb = new Database(join(projectDir, 'hosted.sqlite'));
    try {
      sqliteDb.exec(CHECKPOINT_TABLES);
      const objects = createBlobStore(join(projectDir, 'objects'));
      const sqlConnection: SqlConnection = {
        exec(sql) {
          sqliteDb.exec(sql);
        },
        prepare(sql) {
          return {
            run(...values: SqlValue[]) {
              return sqliteDb.query(sql).run(...values);
            },
            get(...values: SqlValue[]) {
              const row = sqliteDb.query(sql).get(...values) as SqlRow | null | undefined;
              return row ?? undefined;
            },
            all(...values: SqlValue[]) {
              return sqliteDb.query(sql).all(...values) as SqlRow[];
            },
          };
        },
        close() {
          sqliteDb.close();
        },
      };
      const hostedCheckpoints = createHostedCheckpointBackend(
        sqlConnection,
        (fn) => fn(),
        objects,
      );
      const hostedCtx = createSurfaceContext(sandbox, projectDir, undefined, {
        ...hostedCheckpoints,
        storage: 'inline',
      });
      const hostedSave = await callMethod(hostedCtx, surface, 'sandbox.checkpoint', {
        name: 'sqlite-snap',
      });
      expect(hostedSave.ok).toBe(true);

      await deleteDoc(
        doc(getFirestore(sandbox.withAuth({ uid: 'u1' }), 'reports'), 'items/shared'),
      );
      const hostedRestore = await callMethod(hostedCtx, surface, 'sandbox.restore', {
        name: 'sqlite-snap',
        confirm: true,
      });
      expect(hostedRestore.ok).toBe(true);
      expect(getDatabaseEnv(sandbox, 'reports').getDocument('items/shared')).toEqual({
        db: 'reports',
        n: 2,
      });
    } finally {
      sqliteDb.close();
    }
  });

  it('forks, replays named-database writes, diffs per database, and promotes onto live', async () => {
    const projectDir = makeDir();
    const surface = renderSurface(undefined);
    const sandbox = freshSandbox();
    const ctx = createSurfaceContext(sandbox, projectDir);

    declareFirestoreDatabase(sandbox, 'reports');
    getDatabaseEnv(sandbox, 'reports').deployRules(REPORTS_OPEN);
    await setDoc(doc(getAdminFirestore(sandbox.withAuth(null)), 'items/shared'), {
      owner: 'default-v1',
    });
    await setDoc(doc(getFirestore(sandbox.withAuth({ uid: 'u1' }), 'reports'), 'items/shared'), {
      owner: 'reports-v1',
    });

    const forked = await callMethod(ctx, surface, 'sandbox.fork', { branch: 'experiment' });
    expect(forked.ok).toBe(true);

    const recordedSandbox = freshSandbox();
    declareFirestoreDatabase(recordedSandbox, 'reports');
    getDatabaseEnv(recordedSandbox, 'reports').deployRules(REPORTS_OPEN);
    await setDoc(
      doc(getFirestore(recordedSandbox.withAuth({ uid: 'u1' }), 'reports'), 'items/new-report'),
      { total: 77 },
    );
    const sessionEvents = buildVerifyFixture({ sandbox: recordedSandbox }).events;

    const applied = await callMethod(ctx, surface, 'sandbox.apply', {
      branch: 'experiment',
      events: sessionEvents,
    });
    expect(applied.ok).toBe(true);

    const diffLive = await callMethod(ctx, surface, 'sandbox.diff', {
      branch: 'experiment',
      against: 'live',
    });
    expect(diffLive.ok).toBe(true);
    const divergences = (
      diffLive.data as {
        divergences: Array<{ path: string; service: string; database?: string }>;
      }
    ).divergences;
    expect(
      divergences.some((d) => d.database === 'reports' && d.path === 'items/new-report'),
    ).toBe(true);

    const promoted = await callMethod(ctx, surface, 'sandbox.promote', {
      branch: 'experiment',
      confirm: true,
    });
    expect(promoted.ok).toBe(true);
    expect(getDatabaseEnv(sandbox, 'reports').getDocument('items/new-report')).toEqual({
      total: 77,
    });
    expect(
      (await getDoc(doc(getAdminFirestore(sandbox.withAuth(null)), 'items/new-report'))).exists(),
    ).toBe(false);

    const lockedSandbox = freshSandbox();
    declareFirestoreDatabase(lockedSandbox, 'reports');
    getDatabaseEnv(lockedSandbox, 'reports').deployRules(REPORTS_LOCKED);
    const lockedCtx = createSurfaceContext(lockedSandbox, projectDir);
    await callMethod(lockedCtx, surface, 'sandbox.fork', { branch: 'locked-branch' });
    await callMethod(lockedCtx, surface, 'sandbox.apply', {
      branch: 'locked-branch',
      events: sessionEvents,
    });
    const lockedDiff = await callMethod(lockedCtx, surface, 'sandbox.diff', {
      branch: 'locked-branch',
      against: 'live',
    });
    expect((lockedDiff.data as { divergences: unknown[] }).divergences).toEqual([]);
  });

  it('preserves { locked: true } rules-less named databases across checkpoint restore, fresh state restore, and branch fork/promote', async () => {
    const projectDir = makeDir();
    const surface = renderSurface(undefined);
    const sandbox = freshSandbox();
    const ctx = createSurfaceContext(sandbox, projectDir);

    declareFirestoreDatabase(sandbox, 'audit-log', { locked: true });
    await setDoc(doc(getAdminFirestore(sandbox.withAuth(null), 'audit-log'), 'entries/e1'), {
      secret: true,
    });

    const canReadLocked = async (sb: ReturnType<typeof initializeSandbox>): Promise<boolean> =>
      getDoc(doc(getFirestore(sb.withAuth({ uid: 'u1' }), 'audit-log'), 'entries/e1')).then(
        () => true,
        () => false,
      );

    expect(await canReadLocked(sandbox)).toBe(false);

    const captured = captureNamedFirestoreState(sandbox);
    expect(captured.locked).toEqual(['audit-log']);

    const freshSb = freshSandbox();
    restoreNamedFirestoreState(freshSb, captured);
    expect(await canReadLocked(freshSb)).toBe(false);
    expect(getDatabaseEnv(freshSb, 'audit-log').getDocument('entries/e1')).toEqual({
      secret: true,
    });

    const cpSaved = await callMethod(ctx, surface, 'sandbox.checkpoint', { name: 'locked-cp' });
    expect(cpSaved.ok).toBe(true);
    getDatabaseEnv(sandbox, 'audit-log').deployRules(REPORTS_OPEN);
    expect(await canReadLocked(sandbox)).toBe(true);

    const cpRestored = await callMethod(ctx, surface, 'sandbox.restore', {
      name: 'locked-cp',
      confirm: true,
    });
    expect(cpRestored.ok).toBe(true);
    expect(getDatabaseEnv(sandbox, 'audit-log').getExplicitRules()).toBeNull();
    expect(await canReadLocked(sandbox)).toBe(false);
    expect(getDatabaseEnv(sandbox, 'audit-log').getDocument('entries/e1')).toEqual({
      secret: true,
    });

    const forked = await callMethod(ctx, surface, 'sandbox.fork', { branch: 'locked-fork' });
    expect(forked.ok).toBe(true);
    const promoted = await callMethod(ctx, surface, 'sandbox.promote', {
      branch: 'locked-fork',
      confirm: true,
    });
    expect(promoted.ok).toBe(true);
    expect(await canReadLocked(sandbox)).toBe(false);
  });

  it('ignores denied request payloads and preserves sequential writes, batches, and autoId writes during sandbox.apply', async () => {
    const projectDir = makeDir();
    const surface = renderSurface(undefined);
    const baseSandbox = freshSandbox();
    declareFirestoreDatabase(baseSandbox, 'reports');
    getDatabaseEnv(baseSandbox, 'reports').deployRules(REPORTS_OPEN);
    const ctx = createSurfaceContext(baseSandbox, projectDir);
    await callMethod(ctx, surface, 'sandbox.fork', { branch: 'seq-branch' });

    const recorded = freshSandbox();
    declareFirestoreDatabase(recorded, 'reports');
    getDatabaseEnv(recorded, 'reports').deployRules(REPORTS_OPEN);

    await setDoc(
      doc(getFirestore(recorded.withAuth({ uid: 'mallory' }), 'reports'), 'items/a'),
      { v: 'DENIED_MALLORY' },
    ).catch(() => {});

    const u1Reports = getFirestore(recorded.withAuth({ uid: 'u1' }), 'reports');
    await setDoc(doc(u1Reports, 'items/a'), { v: 1 });
    await setDoc(doc(u1Reports, 'items/a'), { v: 2 });

    const batch = writeBatch(u1Reports);
    batch.set(doc(u1Reports, 'items/b1'), { step: 'batch-1' });
    batch.set(doc(u1Reports, 'items/b2'), { step: 'batch-2' });
    await batch.commit();

    const minted = await addDoc(collection(u1Reports, 'items'), { kind: 'auto' });

    const applied = await callMethod(ctx, surface, 'sandbox.apply', {
      branch: 'seq-branch',
      events: recorded.history(),
    });
    expect(applied.ok).toBe(true);

    const promoted = await callMethod(ctx, surface, 'sandbox.promote', {
      branch: 'seq-branch',
      confirm: true,
    });
    expect(promoted.ok).toBe(true);
    expect(getDatabaseEnv(baseSandbox, 'reports').getDocument('items/a')).toEqual({ v: 2 });
    expect(getDatabaseEnv(baseSandbox, 'reports').getDocument('items/b1')).toEqual({
      step: 'batch-1',
    });
    expect(getDatabaseEnv(baseSandbox, 'reports').getDocument('items/b2')).toEqual({
      step: 'batch-2',
    });
    expect(getDatabaseEnv(baseSandbox, 'reports').getDocument(minted.path)).toEqual({
      kind: 'auto',
    });
  });
});
