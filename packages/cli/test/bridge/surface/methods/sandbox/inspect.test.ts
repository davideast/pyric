import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { getAdminDatabase, getDatabase, ref as rtdbRef, sandbox as rtdbSandbox, set as rtdbSet } from 'pyric/database';
import { doc, getDoc, getFirestore, setDoc } from 'pyric/firestore';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';
import { ref as storageRef, uploadBytes } from 'pyric/storage';
import { getAdminStorageSandbox, replaceStorageRules } from 'pyric/storage/internal';

import { createSurfaceContext, renderSurface } from '../../../../../src/bridge/surface/index.js';
import type { OperationResult, SurfaceContext } from '../../../../../src/bridge/surface/index.js';

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} { allow read, write: if request.auth != null; }
  }
}`;

const STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{uid}/{name} { allow read, write: if request.auth != null; }
  }
}`;

const sdkSurface = renderSurface(undefined);
const verbSurface = renderSurface('verb-prefixed');

let projectDir: string;
let sandbox: LocalSandbox;
let ctx: SurfaceContext;
let nextStorageDb = 1;

async function runSdk(key: string, args: Record<string, unknown> = {}): Promise<OperationResult> {
  const [toolName, method] = key.split('.');
  const tool = sdkSurface.tools.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`no rendered tool named ${toolName}`);
  return tool.execute({ method, args }, ctx);
}

async function runCanonical(toolName: string, args: Record<string, unknown> = {}): Promise<OperationResult> {
  const tool = verbSurface.tools.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`no canonical tool named ${toolName}`);
  return tool.execute(args, ctx);
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'pyric-inspect-'));
  sandbox = initializeSandbox();
  ctx = createSurfaceContext(sandbox, projectDir);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('Slice 4.3: multi-service sandbox.inspect / inspect_sandbox', () => {
  it('reports firestore, database, storage, auth, events, and clock without polluting sandbox history', async () => {
    setFirestoreRules(sandbox, FIRESTORE_RULES);
    await runSdk('firestore.setDoc', { path: 'items/item-1', data: { name: 'alpha' } });

    const rtdb = getDatabase(sandbox);
    rtdbSandbox.setRules(rtdb, { rules: { items: { '.read': 'auth != null' } } });
    await rtdbSet(rtdbRef(getAdminDatabase(sandbox), 'items/item-1'), { active: true });

    const storage = getAdminStorageSandbox(sandbox, { dbName: `pyric-inspect-db:${nextStorageDb++}` });
    await replaceStorageRules(sandbox, STORAGE_RULES);
    await uploadBytes(storageRef(storage, 'files/u1/doc.bin'), new Uint8Array([1, 2, 3, 4, 5]), {
      contentType: 'application/octet-stream',
    });

    authSandbox.seedUsers(getAuth(sandbox), [
      {
        uid: 'u1',
        email: 'u1@example.test',
        password: 'hidden-password',
        emailVerified: true,
        tenantId: 'org-1',
      },
    ]);

    // Trigger two denied client reads so recentEventLimit can be verified.
    const unauthedDb = getFirestore(sandbox);
    await getDoc(doc(unauthedDb, 'items/item-1')).catch(() => undefined);
    await getDoc(doc(unauthedDb, 'items/item-2')).catch(() => undefined);

    await runSdk('sandbox.setClock', { isoTime: '2026-06-01T00:00:00.000Z' });
    const historyLengthBefore = sandbox.history().length;

    const first = await runSdk('sandbox.inspect', { recentEventLimit: 1 });
    const second = await runCanonical('inspect_sandbox', { includeData: true, recentEventLimit: 1 });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(sandbox.history().length).toBe(historyLengthBefore);

    const firstData = first.data as {
      documents: { totalCount: number };
      firestore: { totalDocuments: number; rulesConfigured: boolean };
      database: { rulesConfigured: boolean; hasData: boolean; topLevelKeys: string[] };
      storage: { rulesConfigured: boolean; totalObjects: number; totalBytes: number };
      auth: { totalUsers: number; verifiedUsers: number; tenants: string[] };
      events: { totalCount: number; recentDenials: unknown[] };
      clock: { mode: string; now: number };
    };
    expect(firstData.documents.totalCount).toBe(1);
    expect(firstData.firestore).toMatchObject({
      rulesConfigured: true,
      totalDocuments: 1,
      byCollection: { items: 1 },
    });
    expect(firstData.database).toMatchObject({
      rulesConfigured: true,
      hasData: true,
      topLevelKeys: ['items'],
    });
    expect(firstData.storage).toMatchObject({
      rulesConfigured: true,
      totalObjects: 1,
      totalBytes: 5,
    });
    expect(firstData.auth).toEqual({
      totalUsers: 1,
      verifiedUsers: 1,
      disabledUsers: 0,
      tenants: ['org-1'],
    });
    expect(firstData.events.recentDenials).toHaveLength(1);
    expect(firstData.clock).toEqual({
      mode: 'fixed',
      now: Date.parse('2026-06-01T00:00:00.000Z'),
    });

    const secondData = second.data as {
      firestore: { preview?: { documents: Record<string, unknown> } };
      storage: { preview?: { objects: Array<{ path: string; size: number }> } };
      auth: { preview?: { users: Array<{ uid: string }> } };
    };
    expect(secondData.firestore.preview?.documents).toEqual({
      'items/item-1': { name: 'alpha' },
    });
    expect(secondData.storage.preview?.objects).toEqual([
      {
        bucket: '(default)',
        path: 'files/u1/doc.bin',
        size: 5,
        contentType: 'application/octet-stream',
      },
    ]);
    expect(secondData.auth.preview?.users).toEqual([
      {
        uid: 'u1',
        email: 'u1@example.test',
        emailVerified: true,
        disabled: false,
        tenantId: 'org-1',
      },
    ]);
    expect(JSON.stringify(secondData)).not.toContain('hidden-password');
  });
});
