import { describe, expect, test, beforeEach } from 'bun:test';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import {
  mutateSandboxData,
  querySandboxData,
  manageStorageFiles,
  switchAuthIdentity,
} from '../../src/actuation/index.js';

describe('Seam 1: Data & Storage Domain Services (data-service & storage-service)', () => {
  let sandbox: LocalSandbox;

  beforeEach(() => {
    sandbox = initializeSandbox();
    setRules(
      sandbox,
      `rules_version = '2';
       service cloud.firestore {
         match /databases/{database}/documents {
           match /users/{uid} {
             allow read, write: if request.auth != null && request.auth.uid == uid;
           }
           match /public/{docId} {
             allow read: if true;
             allow write: if request.auth != null && request.auth.token.firebase.tenant == 'acme';
           }
         }
       }`
    );
  });

  test('mutateSandboxData performs atomic set, update, and delete on Firestore with admin override', async () => {
    const setRes = await mutateSandboxData(sandbox, {
      service: 'firestore',
      action: 'set',
      path: 'users/alice',
      dataJson: JSON.stringify({ name: 'Alice', role: 'engineer' }),
      auth: { mode: 'admin' },
    });
    expect(setRes.ok).toBe(true);
    expect(setRes.committed).toBe(1);
    expect(setRes.paths).toEqual(['users/alice']);

    const updateRes = await mutateSandboxData(sandbox, {
      service: 'firestore',
      action: 'update',
      path: 'users/alice',
      dataJson: JSON.stringify({ role: 'staff-engineer' }),
      auth: { mode: 'admin' },
    });
    expect(updateRes.ok).toBe(true);

    const queryRes = await querySandboxData(sandbox, {
      service: 'firestore',
      path: 'users/alice',
      auth: { mode: 'admin' },
    });
    expect(queryRes.ok).toBe(true);
    expect(queryRes.count).toBe(1);
    expect(queryRes.results[0]?.data).toEqual({
      name: 'Alice',
      role: 'staff-engineer',
    });

    const delRes = await mutateSandboxData(sandbox, {
      service: 'firestore',
      action: 'delete',
      path: 'users/alice',
      auth: { mode: 'admin' },
    });
    expect(delRes.ok).toBe(true);

    const afterDel = await querySandboxData(sandbox, {
      service: 'firestore',
      path: 'users/alice',
      auth: { mode: 'admin' },
    });
    expect(afterDel.count).toBe(0);
  });

  test('mutateSandboxData enforces Security Rules and Full-Lifecycle tenant propagation', async () => {
    // Attempt write to /public/doc1 with wrong tenant -> denied
    const deniedRes = await mutateSandboxData(sandbox, {
      service: 'firestore',
      action: 'set',
      path: 'public/doc1',
      dataJson: JSON.stringify({ title: 'Denied Doc' }),
      auth: { mode: 'uid', uid: 'bob', tenant: 'wrong-tenant' },
    });
    expect(deniedRes.ok).toBe(false);

    // Attempt write to /public/doc1 with matching tenant 'acme' -> allowed
    const allowedRes = await mutateSandboxData(sandbox, {
      service: 'firestore',
      action: 'set',
      path: 'public/doc1',
      dataJson: JSON.stringify({ title: 'Tenant Verified Doc' }),
      auth: { mode: 'uid', uid: 'bob', tenant: 'acme' },
    });
    expect(allowedRes.ok).toBe(true);
    expect(allowedRes.committed).toBe(1);
  });

  test('mutateSandboxData supports atomic batch writes and queries with filters, sorting, and limits', async () => {
    const batchRes = await mutateSandboxData(sandbox, {
      service: 'firestore',
      action: 'batch',
      auth: { mode: 'admin' },
      batchOps: [
        {
          op: 'set',
          path: 'items/item1',
          dataJson: JSON.stringify({ name: 'Keyboard', price: 100, category: 'hw' }),
        },
        {
          op: 'set',
          path: 'items/item2',
          dataJson: JSON.stringify({ name: 'Monitor', price: 300, category: 'hw' }),
        },
        {
          op: 'set',
          path: 'items/item3',
          dataJson: JSON.stringify({ name: 'Mouse', price: 50, category: 'hw' }),
        },
      ],
    });
    expect(batchRes.ok).toBe(true);
    expect(batchRes.committed).toBe(3);

    const queryRes = await querySandboxData(sandbox, {
      service: 'firestore',
      path: 'items',
      auth: { mode: 'admin' },
      filters: [
        { field: 'price', op: '>=', valueJson: '100' },
      ],
      orderByField: 'price',
      orderDirection: 'desc',
      limit: 2,
    });
    expect(queryRes.ok).toBe(true);
    expect(queryRes.count).toBe(2);
    expect((queryRes.results[0]?.data as { name: string }).name).toBe('Monitor');
    expect((queryRes.results[1]?.data as { name: string }).name).toBe('Keyboard');
  });

  test('mutateSandboxData and querySandboxData operate across Realtime Database (database)', async () => {
    const setRes = await mutateSandboxData(sandbox, {
      service: 'database',
      action: 'set',
      path: 'rooms/lobby',
      dataJson: JSON.stringify({ title: 'General Lobby', active: true, count: 5 }),
      auth: { mode: 'admin' },
    });
    expect(setRes.ok).toBe(true);

    const queryRes = await querySandboxData(sandbox, {
      service: 'database',
      path: 'rooms/lobby',
      auth: { mode: 'admin' },
    });
    expect(queryRes.ok).toBe(true);
    expect(queryRes.count).toBe(1);
    expect(queryRes.results[0]?.data).toEqual({
      title: 'General Lobby',
      active: true,
      count: 5,
    });
  });

  test('manageStorageFiles supports upload (base64), download (data: URI), list, and delete with active auth lens', async () => {
    const payload = Buffer.from('Hello Pyric Storage!').toString('base64');

    // Unauthenticated upload without admin lens is denied by default Storage rules
    const unauthUpload = await manageStorageFiles(sandbox, {
      action: 'upload',
      path: 'docs/hello.txt',
      base64Content: payload,
      contentType: 'text/plain',
    });
    expect(unauthUpload.ok).toBe(false);

    // Switch active identity lens to admin -> storage operations succeed without inline auth
    await switchAuthIdentity(sandbox, { mode: 'admin' });

    const uploadRes = await manageStorageFiles(sandbox, {
      action: 'upload',
      path: 'docs/hello.txt',
      base64Content: payload,
      contentType: 'text/plain',
      customMetadataJson: JSON.stringify({ author: 'worker_m1_1' }),
    });
    expect(uploadRes.ok).toBe(true);
    expect(uploadRes.path).toBe('docs/hello.txt');

    const listRes = await manageStorageFiles(sandbox, {
      action: 'list',
      path: 'docs',
    });
    expect(listRes.ok).toBe(true);
    expect(listRes.items).toContain('docs/hello.txt');

    const downloadRes = await manageStorageFiles(sandbox, {
      action: 'download',
      path: 'docs/hello.txt',
    });
    expect(downloadRes.ok).toBe(true);
    expect(downloadRes.dataUri).toStartWith('data:text/plain');
    expect(downloadRes.dataUri).toContain(';base64,');
    expect(downloadRes.dataUri).toContain(payload);

    const deleteRes = await manageStorageFiles(sandbox, {
      action: 'delete',
      path: 'docs/hello.txt',
    });
    expect(deleteRes.ok).toBe(true);
  });

  test('Challenger Bug 1 regression: switchAuthIdentity active identity lens propagates to mutateSandboxData and querySandboxData when inline auth is omitted', async () => {
    // 1. Switch to uid 'alice' -> should allow write to users/alice without inline auth
    await switchAuthIdentity(sandbox, { mode: 'uid', uid: 'alice' });
    const aliceWrite = await mutateSandboxData(sandbox, {
      service: 'firestore',
      action: 'set',
      path: 'users/alice',
      data: { name: 'Alice', bio: 'Active Lens Write' },
    });
    expect(aliceWrite.ok).toBe(true);

    // Query back without inline auth
    const aliceRead = await querySandboxData(sandbox, {
      service: 'firestore',
      path: 'users/alice',
    });
    expect(aliceRead.ok).toBe(true);
    expect(aliceRead.count).toBe(1);

    // 2. Switch to anonymous -> write to users/alice without inline auth should be denied
    await switchAuthIdentity(sandbox, { mode: 'anonymous' });
    const anonWrite = await mutateSandboxData(sandbox, {
      service: 'firestore',
      action: 'set',
      path: 'users/alice',
      data: { name: 'Alice Anonymous Hack' },
    });
    expect(anonWrite.ok).toBe(false);

    // 3. Switch to admin -> write to users/bob without inline auth should succeed
    await switchAuthIdentity(sandbox, { mode: 'admin' });
    const adminWrite = await mutateSandboxData(sandbox, {
      service: 'firestore',
      action: 'set',
      path: 'users/bob',
      data: { name: 'Bob Created By Admin Lens' },
    });
    expect(adminWrite.ok).toBe(true);
  });
});
