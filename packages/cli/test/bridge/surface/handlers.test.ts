/**
 * Every operation's handler, exercised once against a real in-process sandbox
 * through the verb-prefixed rendering, and the tenant projection proved by a
 * rules simulation that reads request.auth.token.firebase.tenant.
 */
import 'fake-indexeddb/auto';
import { afterAll, expect, it } from 'bun:test';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';

import { createSurfaceContext, renderSurface } from '../../../src/bridge/surface/index.js';
import type { OperationResult, SurfaceContext } from '../../../src/bridge/surface/index.js';
import { CANONICAL_OPERATION_IDS } from './canonical-operations.js';

const TENANT_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /tenants/{docId} {
      allow read, write: if request.auth.token.firebase.tenant == 'tenant-a';
    }
  }
}`;

const DATABASE_RULES = JSON.stringify({ rules: { '.read': true, '.write': true } });

const STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

const sandbox = initializeSandbox();
setRules(sandbox, TENANT_RULES);

const surface = renderSurface('verb-prefixed');
const ctx: SurfaceContext = createSurfaceContext(sandbox);
const exercised = new Set<string>();

/** Run one operation through its rendered tool and record that it ran. */
async function run(id: string, args: Record<string, unknown> = {}): Promise<OperationResult> {
  const tool = surface.tools.find((candidate) => candidate.name === id);
  if (!tool) throw new Error(`no rendered tool named ${id}`);
  exercised.add(id);
  return tool.execute(args, ctx);
}

afterAll(() => {
  expect([...exercised].sort()).toEqual([...CANONICAL_OPERATION_IDS].sort());
});

it('projects a seeded tenant and claims into the token rules evaluate', async () => {
  const created = await run('create_auth_user', {
    uid: 'alice',
    email: 'alice@example.com',
    claims: { role: 'owner' },
    tenant: 'tenant-a',
  });
  expect(created.ok).toBe(true);
  const stored = authSandbox.exportUsers(getAuth(sandbox)).find((user) => user.uid === 'alice');
  expect(stored?.tenantId).toBe('tenant-a');
  expect(stored?.customClaims).toEqual({ role: 'owner' });

  const allowed = await run('simulate_firestore_rules', {
    operation: 'get',
    path: 'tenants/t1',
    uid: 'alice',
  });
  expect(allowed.ok).toBe(true);
  expect((allowed.data as { allowed: boolean }).allowed).toBe(true);
});

it('explains a denial for an identity without the tenant', async () => {
  const created = await run('create_auth_user', { uid: 'bob', email: 'bob@example.com' });
  expect(created.ok).toBe(true);

  const diagnosed = await run('diagnose_firestore_denial', {
    operation: 'get',
    path: 'tenants/t1',
    uid: 'bob',
  });
  expect(diagnosed.ok).toBe(true);
  expect((diagnosed.data as { allowed: boolean }).allowed).toBe(false);
});

it('administers the user pool', async () => {
  expect((await run('get_auth_user', { uid: 'alice' })).ok).toBe(true);
  expect((await run('list_auth_users', { limit: 10 })).ok).toBe(true);
  expect((await run('update_auth_user', { uid: 'alice', displayName: 'Alice' })).ok).toBe(true);
  expect((await run('set_auth_claims', { uid: 'alice', claims: { role: 'admin' } })).ok).toBe(true);
  expect((await run('delete_auth_user', { uid: 'bob' })).ok).toBe(true);
});

it('switches the identity every later call runs under', async () => {
  const switched = await run('switch_auth_identity', {
    mode: 'uid',
    uid: 'alice',
    tenant: 'tenant-a',
  });
  expect(switched.ok).toBe(true);
  expect(ctx.identity.describe().uid).toBe('alice');

  const back = await run('switch_auth_identity', { mode: 'admin' });
  expect(back.ok).toBe(true);
});

it('reads and writes Firestore documents', async () => {
  expect((await run('write_firestore_document', { path: 'rooms/lobby', data: { open: true } })).ok)
    .toBe(true);
  expect(
    (await run('update_firestore_document', { path: 'rooms/lobby', data: { seats: 4 } })).ok,
  ).toBe(true);

  const added = await run('add_firestore_document', { path: 'rooms', data: { open: false } });
  expect(added.ok).toBe(true);

  const read = await run('get_firestore_document', { path: 'rooms/lobby' });
  expect((read.data as { data: { seats: number } }).data.seats).toBe(4);

  const listed = await run('list_firestore_documents', { path: 'rooms' });
  expect((listed.data as { docs: unknown[] }).docs.length).toBe(2);

  const matched = await run('query_firestore_documents', {
    path: 'rooms',
    filters: [{ field: 'open', op: '==', value: true }],
  });
  expect((matched.data as { docs: unknown[] }).docs).toHaveLength(1);

  expect(
    (
      await run('batch_firestore_writes', {
        writes: [{ op: 'set', path: 'rooms/annex', data: { open: true } }],
      })
    ).ok,
  ).toBe(true);
  expect((await run('delete_firestore_document', { path: 'rooms/annex' })).ok).toBe(true);
});

it('reads and writes the Realtime Database tree', async () => {
  expect((await run('write_database_value', { path: 'rooms/lobby', value: { open: true } })).ok)
    .toBe(true);
  expect((await run('update_database_value', { path: 'rooms/lobby', value: { seats: 2 } })).ok)
    .toBe(true);

  const read = await run('get_database_value', { path: 'rooms/lobby' });
  expect((read.data as { value: { seats: number } }).value.seats).toBe(2);

  const queried = await run('query_database_values', { path: 'rooms', limitToFirst: 5 });
  expect(queried.ok).toBe(true);

  expect((await run('delete_database_value', { path: 'rooms/lobby/seats' })).ok).toBe(true);
});

it('stores and reads back a Cloud Storage object', async () => {
  const payload = Buffer.from('hello pyric').toString('base64');
  expect(
    (
      await run('upload_storage_file', {
        path: 'uploads/note.txt',
        contentBase64: payload,
        contentType: 'text/plain',
        metadata: { owner: 'alice' },
      })
    ).ok,
  ).toBe(true);

  const downloaded = await run('download_storage_file', { path: 'uploads/note.txt' });
  expect((downloaded.data as { contentBase64: string }).contentBase64).toBe(payload);

  const metadata = await run('get_storage_metadata', { path: 'uploads/note.txt' });
  expect(metadata.ok).toBe(true);

  const listed = await run('list_storage_files', { prefix: 'uploads' });
  expect((listed.data as { items: string[] }).items).toContain('uploads/note.txt');

  expect((await run('delete_storage_file', { path: 'uploads/note.txt' })).ok).toBe(true);
});

it('lints and simulates the rules of all three services', async () => {
  expect((await run('lint_firestore_rules')).ok).toBe(true);
  expect((await run('lint_database_rules', { rules: DATABASE_RULES })).ok).toBe(true);
  expect((await run('lint_storage_rules', { rules: STORAGE_RULES })).ok).toBe(true);

  const database = await run('simulate_database_rules', {
    operation: 'read',
    path: 'rooms/lobby',
    rules: DATABASE_RULES,
  });
  expect((database.data as { allowed: boolean }).allowed).toBe(true);

  const storage = await run('simulate_storage_rules', {
    operation: 'get',
    path: 'uploads/note.txt',
    rules: STORAGE_RULES,
  });
  expect((storage.data as { allowed: boolean }).allowed).toBe(true);
});

it('reads the rules standard library', async () => {
  expect((await run('list_rules_stdlib')).ok).toBe(true);
  expect((await run('get_rules_stdlib', { module: 'math' })).ok).toBe(true);
});

it('inspects, seeds, and resets the sandbox', async () => {
  const inspected = await run('inspect_sandbox');
  expect(inspected.ok).toBe(true);

  const snapshot = sandbox.snapshot() as unknown as Record<string, unknown>;
  expect((await run('seed_sandbox', { snapshot })).ok).toBe(true);
  expect((await run('reset_sandbox')).ok).toBe(true);
});

it('reaches the same handler through the discriminator rendering', async () => {
  const discriminator = renderSurface('discriminator');
  const manage = discriminator.tools.find((tool) => tool.name === 'manage_auth_users');
  expect(manage).toBeDefined();

  const created = await manage!.execute(
    {
      action: 'create',
      uid: 'carol',
      email: 'carol@example.com',
      claimsJson: JSON.stringify({ role: 'auditor' }),
    },
    ctx,
  );
  expect(created.ok).toBe(true);

  const read = await run('get_auth_user', { uid: 'carol' });
  const user = (read.data as { user: { claims?: Record<string, unknown> } }).user;
  expect(user.claims).toEqual({ role: 'auditor' });
});
