/**
 * Partial recovery (`pyric sandbox salvage`) tests for the in-process MCP
 * store (`in-process.json` and optional `storage.json` sidecar).
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleRecords, initializeSandbox } from 'pyric/sandbox';
import { createUserWithEmailAndPassword, getAuth } from 'pyric/auth';
import { getAdminDatabase, ref as dbRef, set as dbSet } from 'pyric/database';
import { doc, getDoc, getFirestore, setDoc } from 'pyric/firestore';
import {
  CHUNK_FORMAT_VERSION,
  V3_BUNDLE_FORMAT,
  checksumDocs,
  pathToBucketId,
} from 'pyric/sandbox/internal';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import { getBytes, ref as storageRef, uploadBytes } from 'pyric/storage';
import {
  IN_PROCESS_STATE_RELATIVE,
  loadSandboxSnapshot,
  openPersistedServices,
  saveSandboxSnapshot,
} from '../../../src/bridge/server/in-process.js';
import { salvageInProcessState } from '../../../src/bridge/server/in-process-salvage.js';
import {
  STORAGE_SIDECAR_RELATIVE,
  loadStorageSidecar,
  saveStorageSidecar,
} from '../../../src/bridge/server/storage-sidecar.js';
import { claimProjectState } from '../../../src/serve/hosted/project-ownership.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function findCollidingDocPath(targetBucket: string): string {
  for (let i = 0; i < 10_000; i++) {
    const candidate = `items/broken-${i}`;
    if (pathToBucketId(candidate) === targetBucket) {
      return candidate;
    }
  }
  throw new Error(`Could not find colliding doc path for bucket ${targetBucket}`);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('salvageInProcessState (#1384)', () => {
  it('excludes a malformed document in the same bucket while recovering sibling docs, services, and storage sidecar', async () => {
    const projectDir = makeTempDir('pyric-inproc-salvage-');
    const sandbox = initializeSandbox();
    openPersistedServices(sandbox, projectDir);
    const db = getFirestore(sandbox);
    await setDoc(doc(db, 'items/keep-a'), { title: 'first', count: 10 });
    await setDoc(doc(db, 'items/keep-b'), { title: 'second', count: 20 });

    const auth = getAuth(sandbox);
    await createUserWithEmailAndPassword(auth, 'alice@example.com', 'password123');
    const rtdb = getAdminDatabase(sandbox);
    await dbSet(dbRef(rtdb, 'counters/visits'), 7);

    const storage = getAdminStorageSandbox(sandbox);
    await uploadBytes(
      storageRef(storage, 'uploads/hello.txt'),
      new TextEncoder().encode('hello world'),
      { contentType: 'text/plain', customMetadata: { owner: 'alice' } },
    );

    saveSandboxSnapshot(sandbox, projectDir);
    await saveStorageSidecar(storage, projectDir);

    // Inject a malformed document into the exact same bucket as `items/keep-a`,
    // recomputing the bucket checksum as a writer bug would have done.
    const statePath = join(projectDir, IN_PROCESS_STATE_RELATIVE);
    const sidecarPath = join(projectDir, STORAGE_SIDECAR_RELATIVE);
    const rawState = JSON.parse(readFileSync(statePath, 'utf8')) as {
      format: string;
      records: Record<string, { docs?: Record<string, unknown>; checksum?: number }>;
    };
    const keepBucketId = pathToBucketId('items/keep-a');
    const collidingBadPath = findCollidingDocPath(keepBucketId);
    const bucket = rawState.records[keepBucketId];
    expect(bucket?.docs).toBeDefined();
    if (bucket?.docs !== undefined) {
      bucket.docs[collidingBadPath] = {
        badTs: { __type: 'timestamp', seconds: 'not-a-number', nanos: 0 },
      };
      bucket.checksum = checksumDocs(bucket.docs);
    }
    writeFileSync(statePath, JSON.stringify(rawState), 'utf8');

    // Also inject one malformed storage entry alongside the valid object.
    const rawSidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as unknown[];
    rawSidecar.push({
      path: 'uploads/corrupt.bin',
      contentBase64: '!!!not-valid-base64!!!',
      metadata: {},
    });
    writeFileSync(sidecarPath, JSON.stringify(rawSidecar), 'utf8');

    const snapshotBytesBefore = readFileSync(statePath);
    const sidecarBytesBefore = readFileSync(sidecarPath);

    // Fail-closed load refuses and points at `pyric sandbox salvage`.
    let loadError: Error | null = null;
    try {
      loadSandboxSnapshot(initializeSandbox(), projectDir);
    } catch (error) {
      if (error instanceof Error) loadError = error;
      else loadError = new Error(String(error));
    }
    expect(loadError).not.toBeNull();
    expect(loadError?.message).toContain('pyric sandbox salvage');

    // Run CLI `pyric sandbox salvage --source <stateDir> --out <outDir>`.
    const sourceStateDir = join(projectDir, '.pyric', 'state');
    const outDir = join(projectDir, 'recovered-state');
    const cliEntry = fileURLToPath(new URL('../../../src/cli/index.ts', import.meta.url));
    const cliResult = spawnSync(
      process.execPath,
      [cliEntry, 'sandbox', 'salvage', '--source', sourceStateDir, '--out', outDir],
      { encoding: 'utf8', timeout: 15_000 },
    );
    expect(cliResult.status).toBe(0);

    // Source files were not altered.
    expect(readFileSync(statePath)).toEqual(snapshotBytesBefore);
    expect(readFileSync(sidecarPath)).toEqual(sidecarBytesBefore);

    const stdoutReport = JSON.parse(cliResult.stdout) as {
      output: string;
      recoveredDocuments: number;
      recoveredServices: number;
      recoveredObjects: number;
      excluded: Array<{ namespace: string; id: string; reason: string }>;
    };
    expect(stdoutReport.recoveredDocuments).toBe(2);
    expect(stdoutReport.recoveredObjects).toBe(1);
    expect(stdoutReport.recoveredServices).toBeGreaterThanOrEqual(2);
    expect(stdoutReport.excluded).toEqual([
      { namespace: 'in-process', id: collidingBadPath, reason: 'Document validation failed' },
      {
        namespace: 'storage',
        id: 'default/uploads/corrupt.bin',
        reason: 'Object base64 payload is malformed',
      },
    ]);
    expect(existsSync(join(outDir, 'recovery-report.json'))).toBe(true);

    // Activate the salvaged copy in a clean project directory and verify full restore.
    const activatedProject = makeTempDir('pyric-inproc-activated-');
    const activatedStateDir = join(activatedProject, '.pyric', 'state');
    mkdirSync(join(activatedProject, '.pyric'), { recursive: true });
    cpSync(outDir, activatedStateDir, { recursive: true });

    const restoredSandbox = initializeSandbox();
    const restoredStorage = openPersistedServices(restoredSandbox, activatedProject);
    const restoredDocCount = loadSandboxSnapshot(restoredSandbox, activatedProject);
    const restoredObjCount = await loadStorageSidecar(restoredStorage, activatedProject);
    expect(restoredDocCount).toBe(2);
    expect(restoredObjCount).toBe(1);

    const restoredDb = getFirestore(restoredSandbox);
    expect((await getDoc(doc(restoredDb, 'items/keep-a'))).data()).toEqual({
      title: 'first',
      count: 10,
    });
    expect((await getDoc(doc(restoredDb, 'items/keep-b'))).data()).toEqual({
      title: 'second',
      count: 20,
    });
    expect((await getDoc(doc(restoredDb, collidingBadPath))).exists()).toBe(false);
    expect(getAuth(restoredSandbox).currentUser?.email).toBe('alice@example.com');

    const bytes = await getBytes(storageRef(restoredStorage, 'uploads/hello.txt'));
    expect(new TextDecoder().decode(bytes)).toBe('hello world');
  });

  it('excludes a tampered checksum-mismatched bucket while recovering intact buckets', async () => {
    const dir = makeTempDir('pyric-inproc-checksum-');
    const goodBucket = pathToBucketId('alpha/one');
    let secondPath = 'beta/two';
    let idx = 0;
    while (pathToBucketId(secondPath) === goodBucket) {
      idx++;
      secondPath = `beta/two-${idx}`;
    }

    const sandbox = initializeSandbox();
    sandbox.admin.setDocument('alpha/one', { ok: true });
    sandbox.admin.setDocument(secondPath, { count: 1 });
    saveSandboxSnapshot(sandbox, dir);

    const statePath = join(dir, IN_PROCESS_STATE_RELATIVE);
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as {
      records: Record<string, { docs?: Record<string, unknown>; checksum?: number }>;
    };
    const tamperedBucketId = pathToBucketId(secondPath);
    const tamperedBucket = parsed.records[tamperedBucketId];
    if (tamperedBucket?.docs !== undefined) {
      tamperedBucket.docs[secondPath] = { count: 999 };
    }
    writeFileSync(statePath, JSON.stringify(parsed), 'utf8');

    const outDir = join(dir, 'salvaged');
    const report = await salvageInProcessState(join(dir, '.pyric', 'state'), outDir);
    expect(report.recoveredDocuments).toBe(1);
    expect(report.excluded).toEqual([
      { namespace: 'in-process', id: tamperedBucketId, reason: 'Bucket checksum mismatch' },
    ]);
  });

  it('refuses existing output, overlapping paths, symlinks, empty recoveries, unsupported encodings, and locked projects', async () => {
    const dir = makeTempDir('pyric-inproc-guards-');
    const stateDir = join(dir, '.pyric', 'state');
    mkdirSync(stateDir, { recursive: true });
    const statePath = join(stateDir, 'in-process.json');
    writeFileSync(
      statePath,
      bundleRecords(
        new Map<string, unknown>([
          ['meta', { version: CHUNK_FORMAT_VERSION, savedAt: 0, services: {} }],
          ['00', { docs: { 'items/broken': null } }],
        ]),
      ),
      'utf8',
    );

    // Empty recovery produces no output directory.
    const emptyOut = join(dir, 'empty-out');
    await expect(salvageInProcessState(stateDir, emptyOut)).rejects.toThrow(/No recoverable state/);
    expect(existsSync(emptyOut)).toBe(false);

    // Valid source for guard checks.
    writeFileSync(
      statePath,
      JSON.stringify({
        format: V3_BUNDLE_FORMAT,
        records: {
          meta: { version: CHUNK_FORMAT_VERSION, savedAt: 0, services: {} },
          '00': { docs: { 'items/valid': { v: 1 } } },
        },
      }),
      'utf8',
    );

    const existingOut = join(dir, 'existing-out');
    mkdirSync(existingOut);
    await expect(salvageInProcessState(stateDir, existingOut)).rejects.toThrow(/already exists/);
    await expect(salvageInProcessState(stateDir, join(stateDir, 'nested'))).rejects.toThrow(
      /separate from the source/,
    );

    const symlinkSource = join(dir, 'symlink-state');
    symlinkSync(stateDir, symlinkSource);
    await expect(salvageInProcessState(symlinkSource, join(dir, 'from-link'))).rejects.toThrow(
      /symlink/,
    );

    // Lock refusal while an in-process owner holds `.pyric/state`.
    const owner = await claimProjectState(dir, 'in-process');
    try {
      await expect(salvageInProcessState(stateDir, join(dir, 'while-locked'))).rejects.toThrow(
        /already owns/,
      );
    } finally {
      owner.close();
    }

    // Unsupported future encoding aborts rather than dropping data.
    writeFileSync(
      statePath,
      JSON.stringify({
        format: V3_BUNDLE_FORMAT,
        records: {
          meta: { version: CHUNK_FORMAT_VERSION, savedAt: 0, services: {} },
          '00': { docs: { 'items/valid': { v: 1 } } },
          '01': { docs: {}, encoding: 'pyric/firestore-values/999' },
        },
      }),
      'utf8',
    );
    await expect(salvageInProcessState(stateDir, join(dir, 'future-out'))).rejects.toThrow(
      /Unsupported Firestore value encoding/,
    );
  });
});
