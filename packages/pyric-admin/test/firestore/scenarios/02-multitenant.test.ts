/**
 * Scenario 2: Multi-Tenant SaaS
 *
 * Workspace isolation via custom claims + role hierarchy + subcollection access.
 * Stdlib: membership, lifecycle, validation
 *
 * Rules: examples/scenarios/02-multitenant.rules
 *
 * Migrated through `pyric/sandbox` — operations dispatch through
 * `getFirestore(sandbox)` instead of `LocalEnvironment.execute`.
 */
import { describe, test, expect } from 'bun:test';
import { resolveModules } from 'pyric/rules/node';
import { makeRoot, runOp } from './_helpers.js';

const SOURCE = `import { hasClaim, hasClaimRole } from 'membership';
import { fieldUnchanged } from 'lifecycle';
import { hasRequired } from 'validation';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /workspaces/{workspaceId} {
      allow read: if hasClaim('workspace_id')
          && request.auth.token.workspace_id == workspaceId;
      allow create: if hasClaimRole('workspace_role', 'admin')
          && request.auth.token.workspace_id == workspaceId
          && hasRequired(['name', 'owner']);
      allow update: if hasClaimRole('workspace_role', 'admin')
          && request.auth.token.workspace_id == workspaceId;
      allow delete: if false;

      match /documents/{docId} {
        allow read: if hasClaim('workspace_id')
            && request.auth.token.workspace_id == workspaceId;
        allow create: if hasClaim('workspace_id')
            && request.auth.token.workspace_id == workspaceId
            && (request.auth.token.workspace_role == 'admin'
                || request.auth.token.workspace_role == 'editor')
            && request.resource.data.createdBy == request.auth.uid
            && hasRequired(['title', 'createdBy']);
        allow update: if hasClaim('workspace_id')
            && request.auth.token.workspace_id == workspaceId
            && (request.auth.token.workspace_role == 'admin'
                || request.auth.token.workspace_role == 'editor')
            && fieldUnchanged('createdBy');
        allow delete: if hasClaimRole('workspace_role', 'admin')
            && request.auth.token.workspace_id == workspaceId;
      }
    }
  }
}`;

const resolved = resolveModules(SOURCE);
if (!resolved.success) throw new Error(resolved.error.message);
const RULES = resolved.data.resolved;

const SEED = {
  'workspaces/ws1': { name: 'Acme Corp', owner: 'alice' },
  'workspaces/ws1/documents/d1': { title: 'Roadmap', createdBy: 'bob', content: 'Q1 plans' },
};

describe('Scenario 2: Multi-Tenant SaaS', () => {
  test('editor creates doc', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'workspaces/ws1/documents/d2', auth: { uid: 'bob', token: { workspace_id: 'ws1', workspace_role: 'editor' } }, data: { title: 'Specs', createdBy: 'bob' } });
    expect(r.allowed).toBe(true);
  });

  test('admin creates doc', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'workspaces/ws1/documents/d3', auth: { uid: 'alice', token: { workspace_id: 'ws1', workspace_role: 'admin' } }, data: { title: 'Budget', createdBy: 'alice' } });
    expect(r.allowed).toBe(true);
  });

  test('editor updates doc', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'workspaces/ws1/documents/d1', auth: { uid: 'bob', token: { workspace_id: 'ws1', workspace_role: 'editor' } }, data: { title: 'Roadmap v2', createdBy: 'bob', content: 'Updated' } });
    expect(r.allowed).toBe(true);
  });

  test('admin deletes doc', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'delete', path: 'workspaces/ws1/documents/d1', auth: { uid: 'alice', token: { workspace_id: 'ws1', workspace_role: 'admin' } } });
    expect(r.allowed).toBe(true);
  });

  test('admin updates workspace', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'workspaces/ws1', auth: { uid: 'alice', token: { workspace_id: 'ws1', workspace_role: 'admin' } }, data: { name: 'Acme Inc', owner: 'alice' } });
    expect(r.allowed).toBe(true);
  });

  test('viewer cannot create doc', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'workspaces/ws1/documents/d4', auth: { uid: 'carol', token: { workspace_id: 'ws1', workspace_role: 'viewer' } }, data: { title: 'Notes', createdBy: 'carol' } });
    expect(r.allowed).toBe(false);
  });

  test('viewer cannot update doc', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'workspaces/ws1/documents/d1', auth: { uid: 'carol', token: { workspace_id: 'ws1', workspace_role: 'viewer' } }, data: { title: 'Hacked', createdBy: 'bob', content: 'Tampered' } });
    expect(r.allowed).toBe(false);
  });

  test('editor cannot delete doc', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'delete', path: 'workspaces/ws1/documents/d1', auth: { uid: 'bob', token: { workspace_id: 'ws1', workspace_role: 'editor' } } });
    expect(r.allowed).toBe(false);
  });

  test('editor cannot update workspace', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'workspaces/ws1', auth: { uid: 'bob', token: { workspace_id: 'ws1', workspace_role: 'editor' } }, data: { name: 'Hacked', owner: 'bob' } });
    expect(r.allowed).toBe(false);
  });

  test('cross-tenant blocked', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'workspaces/ws1/documents/d5', auth: { uid: 'eve', token: { workspace_id: 'ws2', workspace_role: 'admin' } }, data: { title: 'Infiltrate', createdBy: 'eve' } });
    expect(r.allowed).toBe(false);
  });

  test('no-claim blocked', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'workspaces/ws1/documents/d6', auth: { uid: 'nobody' }, data: { title: 'Sneak', createdBy: 'nobody' } });
    expect(r.allowed).toBe(false);
  });

  test('createdBy tamper blocked', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'workspaces/ws1/documents/d1', auth: { uid: 'bob', token: { workspace_id: 'ws1', workspace_role: 'editor' } }, data: { title: 'Roadmap', createdBy: 'alice', content: 'Q1 plans' } });
    expect(r.allowed).toBe(false);
  });
});
