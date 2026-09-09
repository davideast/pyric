/**
 * Every method record's handler, exercised once against a real in-process
 * sandbox through the service tools, and the tenant projection proved by a
 * rules simulation that reads request.auth.token.firebase.tenant.
 *
 * The calls go through the rendered tool rather than straight to the handler,
 * so each one passes the validator the product would put in front of it.
 */
import 'fake-indexeddb/auto';
import { afterAll, expect, it } from 'bun:test';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';

import { createSurfaceContext, renderSurface } from '../../../src/bridge/surface/index.js';
import type { OperationResult, SurfaceContext } from '../../../src/bridge/surface/index.js';
import { METHODS } from '../../../src/bridge/surface/methods/index.js';

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

const SIGNED_IN_ONLY_STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;

const sandbox = initializeSandbox();
setRules(sandbox, TENANT_RULES);

const surface = renderSurface(undefined);
const ctx: SurfaceContext = createSurfaceContext(sandbox);
const exercised = new Set<string>();

/** Call one method through its service tool and record that it ran. */
async function run(
  key: string,
  args: Record<string, unknown> = {},
): Promise<OperationResult> {
  const [toolName, method] = key.split('.');
  const tool = surface.tools.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`no rendered tool named ${toolName}`);
  exercised.add(key);
  return tool.execute({ method, args }, ctx);
}

afterAll(() => {
  expect([...exercised].sort()).toEqual(METHODS.map((method) => method.key).sort());
});

it('projects a seeded tenant and claims into the token rules evaluate', async () => {
  const created = await run('auth.createUser', {
    uid: 'alice',
    email: 'alice@example.com',
    customClaims: { role: 'owner' },
    tenantId: 'tenant-a',
  });
  expect(created.ok).toBe(true);
  const stored = authSandbox.exportUsers(getAuth(sandbox)).find((user) => user.uid === 'alice');
  expect(stored?.tenantId).toBe('tenant-a');
  expect(stored?.customClaims).toEqual({ role: 'owner' });

  const allowed = await run('rules.simulate', {
    service: 'firestore',
    operation: 'get',
    path: 'tenants/t1',
    uid: 'alice',
  });
  expect(allowed.ok).toBe(true);
  expect((allowed.data as { allowed: boolean }).allowed).toBe(true);
});

it('simulates a user seeded outside the session under its stored tenant and claims', async () => {
  authSandbox.seedUsers(getAuth(sandbox), [
    {
      uid: 'carol',
      email: 'carol@example.com',
      password: 'seed-carol',
      tenantId: 'tenant-a',
      customClaims: { role: 'viewer' },
    },
  ]);
  const allowed = await run('rules.simulate', {
    service: 'firestore',
    operation: 'get',
    path: 'tenants/t1',
    uid: 'carol',
  });
  expect(allowed.ok).toBe(true);
  const data = allowed.data as { allowed: boolean; auth: { token: Record<string, unknown> } };
  expect(data.allowed).toBe(true);
  expect(data.auth.token).toMatchObject({ role: 'viewer', firebase: { tenant: 'tenant-a' } });
});

it('explains a denial for an identity without the tenant', async () => {
  const created = await run('auth.createUser', { uid: 'bob', email: 'bob@example.com' });
  expect(created.ok).toBe(true);

  const diagnosed = await run('rules.explainDenial', {
    operation: 'get',
    path: 'tenants/t1',
    uid: 'bob',
  });
  expect(diagnosed.ok).toBe(true);
  expect((diagnosed.data as { allowed: boolean }).allowed).toBe(false);
});

it('administers the user pool', async () => {
  expect((await run('auth.getUser', { uid: 'alice' })).ok).toBe(true);
  expect((await run('auth.listUsers', { maxResults: 10 })).ok).toBe(true);
  expect((await run('auth.updateUser', { uid: 'alice', displayName: 'Alice' })).ok).toBe(true);
  expect(
    (await run('auth.setCustomUserClaims', { uid: 'alice', customClaims: { role: 'admin' } })).ok,
  ).toBe(true);
  expect((await run('auth.deleteUser', { uid: 'bob' })).ok).toBe(true);
});

it('switches the identity every later call runs under', async () => {
  const switched = await run('auth.impersonate', { uid: 'alice', tenantId: 'tenant-a' });
  expect(switched.ok).toBe(true);
  expect(ctx.identity.describe().uid).toBe('alice');

  const anonymous = await run('auth.actAsAnonymous');
  expect(anonymous.ok).toBe(true);
  expect(ctx.identity.describe().mode).toBe('anonymous');

  const app = await run('auth.useAppSession');
  expect(app.ok).toBe(true);
  expect(ctx.identity.describe().mode).toBe('app-session');

  const back = await run('auth.actAsAdmin');
  expect(back.ok).toBe(true);
  expect(ctx.identity.describe().mode).toBe('admin');
});

it('reads and writes Firestore documents', async () => {
  expect((await run('firestore.setDoc', { path: 'rooms/lobby', data: { open: true } })).ok).toBe(
    true,
  );
  expect((await run('firestore.updateDoc', { path: 'rooms/lobby', data: { seats: 4 } })).ok).toBe(
    true,
  );

  const added = await run('firestore.addDoc', { path: 'rooms', data: { open: false } });
  expect(added.ok).toBe(true);

  const read = await run('firestore.getDoc', { path: 'rooms/lobby' });
  expect((read.data as { data: { seats: number } }).data.seats).toBe(4);

  const listed = await run('firestore.getDocs', { path: 'rooms' });
  expect((listed.data as { docs: unknown[] }).docs.length).toBe(2);

  const matched = await run('firestore.getDocs', {
    path: 'rooms',
    constraints: [{ type: 'where', field: 'open', op: '==', value: true }],
  });
  expect((matched.data as { docs: unknown[] }).docs).toHaveLength(1);

  expect(
    (
      await run('firestore.writeBatch', {
        writes: [{ type: 'set', path: 'rooms/annex', data: { open: true } }],
      })
    ).ok,
  ).toBe(true);
  expect((await run('firestore.deleteDoc', { path: 'rooms/annex' })).ok).toBe(true);
});

it('reads and writes the Realtime Database tree', async () => {
  expect((await run('database.set', { path: 'rooms/lobby', value: { open: true } })).ok).toBe(true);
  expect((await run('database.update', { path: 'rooms/lobby', values: { seats: 2 } })).ok).toBe(
    true,
  );

  const read = await run('database.get', { path: 'rooms/lobby' });
  expect((read.data as { value: { seats: number } }).value.seats).toBe(2);

  const queried = await run('database.query', { path: 'rooms', limitToFirst: 5 });
  expect(queried.ok).toBe(true);

  expect((await run('database.remove', { path: 'rooms/lobby/seats' })).ok).toBe(true);
});

it('stores and reads back a Cloud Storage object', async () => {
  const payload = Buffer.from('hello pyric').toString('base64');
  expect(
    (
      await run('storage.uploadBytes', {
        path: 'uploads/note.txt',
        contentBase64: payload,
        metadata: { contentType: 'text/plain', customMetadata: { owner: 'alice' } },
      })
    ).ok,
  ).toBe(true);

  const downloaded = await run('storage.getBytes', { path: 'uploads/note.txt' });
  expect((downloaded.data as { contentBase64: string }).contentBase64).toBe(payload);

  const metadata = await run('storage.getMetadata', { path: 'uploads/note.txt' });
  expect(metadata.ok).toBe(true);

  const listed = await run('storage.listAll', { prefix: 'uploads' });
  expect((listed.data as { items: string[] }).items).toContain('uploads/note.txt');

  expect((await run('storage.deleteObject', { path: 'uploads/note.txt' })).ok).toBe(true);
});

it('lints and simulates the rules of all three services', async () => {
  expect((await run('rules.lint', { service: 'firestore' })).ok).toBe(true);
  expect((await run('rules.lint', { service: 'database', rules: DATABASE_RULES })).ok).toBe(true);
  expect((await run('rules.lint', { service: 'storage', rules: STORAGE_RULES })).ok).toBe(true);

  const database = await run('rules.simulate', {
    service: 'database',
    operation: 'read',
    path: 'rooms/lobby',
    rules: DATABASE_RULES,
  });
  expect((database.data as { allowed: boolean }).allowed).toBe(true);

  const storage = await run('rules.simulate', {
    service: 'storage',
    operation: 'get',
    path: 'uploads/note.txt',
    rules: STORAGE_RULES,
  });
  expect((storage.data as { allowed: boolean }).allowed).toBe(true);
});

it('reads the rules standard library', async () => {
  expect((await run('rules.listStdlib')).ok).toBe(true);
  expect((await run('rules.getStdlib', { module: 'math' })).ok).toBe(true);
});

it('inspects, seeds, and resets the sandbox', async () => {
  const inspected = await run('sandbox.inspect');
  expect(inspected.ok).toBe(true);

  const seeded = await run('sandbox.seed', {
    users: [{ uid: 'seeded-dana', email: 'dana@example.com', tenantId: 'tenant-a' }],
    firestore: { 'rooms/seeded': { open: true } },
  });
  expect(seeded.ok).toBe(true);
  const readSeeded = await run('firestore.getDoc', { path: 'rooms/seeded' });
  expect((readSeeded.data as { data: { open: boolean } }).data.open).toBe(true);

  const rejected = await run('sandbox.seed', { snapshot: {} });
  expect(rejected.ok).toBe(false);
  expect(rejected.summary).toContain('snapshot');

  expect((await run('sandbox.reset', { confirm: true })).ok).toBe(true);
});

it('reports the identity every later call runs under', async () => {
  await run('auth.impersonate', { uid: 'alice', tenantId: 'tenant-a' });
  const identity = await run('auth.whoami');
  expect(identity.ok).toBe(true);
  expect((identity.data as { identity: { uid: string } }).identity.uid).toBe('alice');
  await run('auth.actAsAdmin');
});

it('installs Firestore and database rules into the running sandbox', async () => {
  const installedFirestore = await run('rules.set', { service: 'firestore', rules: TENANT_RULES });
  expect(installedFirestore.ok).toBe(true);
  const allowed = await run('rules.simulate', {
    service: 'firestore',
    operation: 'get',
    path: 'tenants/t1',
    uid: 'alice',
  });
  expect((allowed.data as { allowed: boolean }).allowed).toBe(true);

  const installedDatabase = await run('rules.set', {
    service: 'database',
    rules: DATABASE_RULES,
  });
  expect(installedDatabase.ok).toBe(true);

  const installedStorage = await run('rules.set', {
    service: 'storage',
    rules: SIGNED_IN_ONLY_STORAGE_RULES,
  });
  expect(installedStorage.ok).toBe(true);
  const anonymousRead = await run('rules.simulate', {
    service: 'storage',
    operation: 'get',
    path: 'uploads/report.pdf',
  });
  expect((anonymousRead.data as { allowed: boolean }).allowed).toBe(false);

  const rejectedStorage = await run('rules.set', {
    service: 'storage',
    rules: 'not rules at all {',
  });
  expect(rejectedStorage.ok).toBe(false);
  expect(rejectedStorage.summary).toContain('did not parse');
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

  const read = await run('auth.getUser', { uid: 'carol' });
  const user = (read.data as { user: { claims?: Record<string, unknown> } }).user;
  expect(user.claims).toEqual({ role: 'auditor' });
});
