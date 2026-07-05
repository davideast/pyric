/**
 * Scenario 20: 3-Level Subcollections
 *
 * Org -> Team -> Task hierarchy with parent/grandparent get() lookups,
 * role-based access at each level, and field immutability.
 * Stdlib: auth, membership, lifecycle, validation
 *
 * Migrated through `@pyric/sandbox` — operations dispatch through
 * `getFirestore(sandbox)` instead of `LocalEnvironment.execute`.
 */
import { describe, test, expect } from 'bun:test';
import { resolveModules } from 'pyric/rules/node';
import { makeRoot, runOp } from './_helpers.js';

const SOURCE = `import { isAuthenticated } from 'auth';
import { isMemberOf, hasRole } from 'membership';
import { fieldUnchanged } from 'lifecycle';
import { hasRequired } from 'validation';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {

    match /orgs/{orgId} {
      allow read: if isAuthenticated()
          && isMemberOf(resource.data.members);
      allow create: if isAuthenticated()
          && request.auth.uid in request.resource.data.members
          && hasRequired(['name', 'members']);
      allow update: if isAuthenticated()
          && hasRole(resource.data.members, 'admin');
      allow delete: if false;

      match /teams/{teamId} {
        allow read: if isAuthenticated()
            && isMemberOf(get(/databases/$(database)/documents/orgs/$(orgId)).data.members);

        allow create: if isAuthenticated()
            && hasRole(get(/databases/$(database)/documents/orgs/$(orgId)).data.members, 'admin')
            && hasRequired(['name', 'members', 'lead']);

        allow update: if isAuthenticated()
            && isMemberOf(get(/databases/$(database)/documents/orgs/$(orgId)).data.members)
            && resource.data.lead == request.auth.uid;

        allow delete: if isAuthenticated()
            && hasRole(get(/databases/$(database)/documents/orgs/$(orgId)).data.members, 'admin');

        match /tasks/{taskId} {
          allow read: if isAuthenticated()
              && isMemberOf(get(/databases/$(database)/documents/orgs/$(orgId)).data.members)
              && isMemberOf(get(/databases/$(database)/documents/orgs/$(orgId)/teams/$(teamId)).data.members);

          allow create: if isAuthenticated()
              && isMemberOf(get(/databases/$(database)/documents/orgs/$(orgId)).data.members)
              && isMemberOf(get(/databases/$(database)/documents/orgs/$(orgId)/teams/$(teamId)).data.members)
              && request.resource.data.createdBy == request.auth.uid
              && hasRequired(['title', 'createdBy', 'assignee', 'status']);

          allow update: if isAuthenticated()
              && isMemberOf(get(/databases/$(database)/documents/orgs/$(orgId)).data.members)
              && isMemberOf(get(/databases/$(database)/documents/orgs/$(orgId)/teams/$(teamId)).data.members)
              && (resource.data.assignee == request.auth.uid
                  || resource.data.createdBy == request.auth.uid)
              && fieldUnchanged('createdBy');

          allow delete: if isAuthenticated()
              && hasRole(get(/databases/$(database)/documents/orgs/$(orgId)).data.members, 'admin');
        }
      }
    }
  }
}`;

const resolved = resolveModules(SOURCE);
if (!resolved.success) throw new Error(resolved.error.message);
const RULES = resolved.data.resolved;

const SEED = {
  'orgs/o1': { name: 'Acme Corp', members: { alice: 'admin', bob: 'member', carol: 'member', dave: 'member' } },
  'orgs/o1/teams/t1': { name: 'Engineering', members: { bob: 'dev', carol: 'dev' }, lead: 'bob' },
  'orgs/o1/teams/t1/tasks/tk1': { title: 'Build API', createdBy: 'bob', assignee: 'carol', status: 'doing' },
  'orgs/o1/teams/t1/tasks/tk2': { title: 'Write Tests', createdBy: 'carol', assignee: 'bob', status: 'todo' },
  'orgs/o1/teams/t2': { name: 'Design', members: { dave: 'designer' }, lead: 'dave' },
};

describe('Scenario 20: 3-Level Subcollections', () => {
  // ═══ ALLOW ═══

  test('admin creates team', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'orgs/o1/teams/t3', auth: { uid: 'alice' }, data: { name: 'Marketing', members: { alice: 'manager' }, lead: 'alice' } });
    expect(r.allowed).toBe(true);
  });

  test('team member creates task', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'orgs/o1/teams/t1/tasks/tk3', auth: { uid: 'bob' }, data: { title: 'Deploy', createdBy: 'bob', assignee: 'carol', status: 'todo' } });
    expect(r.allowed).toBe(true);
  });

  test('assignee updates task', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'orgs/o1/teams/t1/tasks/tk1', auth: { uid: 'carol' }, data: { title: 'Build API v2', createdBy: 'bob', assignee: 'carol', status: 'done' } });
    expect(r.allowed).toBe(true);
  });

  test('creator updates task', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'orgs/o1/teams/t1/tasks/tk1', auth: { uid: 'bob' }, data: { title: 'Build API v2', createdBy: 'bob', assignee: 'carol', status: 'done' } });
    expect(r.allowed).toBe(true);
  });

  test('lead updates team', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'orgs/o1/teams/t1', auth: { uid: 'bob' }, data: { name: 'Engineering (Renamed)', members: { bob: 'dev', carol: 'dev' }, lead: 'bob' } });
    expect(r.allowed).toBe(true);
  });

  test('admin deletes team', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'delete', path: 'orgs/o1/teams/t2', auth: { uid: 'alice' } });
    expect(r.allowed).toBe(true);
  });

  test('admin deletes task', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'delete', path: 'orgs/o1/teams/t1/tasks/tk1', auth: { uid: 'alice' } });
    expect(r.allowed).toBe(true);
  });

  // ═══ DENY ═══

  test('non-org-member denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'orgs/o1/teams/t1/tasks/tk4', auth: { uid: 'eve' }, data: { title: 'Hack', createdBy: 'eve', assignee: 'eve', status: 'todo' } });
    expect(r.allowed).toBe(false);
  });

  test('non-team-member denied (even if org member)', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'orgs/o1/teams/t1/tasks/tk5', auth: { uid: 'dave' }, data: { title: 'Intrude', createdBy: 'dave', assignee: 'dave', status: 'todo' } });
    expect(r.allowed).toBe(false);
  });

  test('non-assignee/creator denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'orgs/o1/teams/t1/tasks/tk1', auth: { uid: 'alice' }, data: { title: 'Tampered', createdBy: 'bob', assignee: 'carol', status: 'done' } });
    expect(r.allowed).toBe(false);
  });

  test('non-admin delete denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'delete', path: 'orgs/o1/teams/t1/tasks/tk1', auth: { uid: 'bob' } });
    expect(r.allowed).toBe(false);
  });

  test('createdBy tamper denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'orgs/o1/teams/t1/tasks/tk1', auth: { uid: 'carol' }, data: { title: 'Build API', createdBy: 'carol', assignee: 'carol', status: 'doing' } });
    expect(r.allowed).toBe(false);
  });

  test('non-lead team update denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'orgs/o1/teams/t1', auth: { uid: 'carol' }, data: { name: 'Hacked Team', members: { bob: 'dev', carol: 'dev' }, lead: 'bob' } });
    expect(r.allowed).toBe(false);
  });

  test('outsider at 3rd level denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'orgs/o1/teams/t1/tasks/tk1', auth: { uid: 'stranger' }, data: { title: 'Hacked', createdBy: 'bob', assignee: 'carol', status: 'done' } });
    expect(r.allowed).toBe(false);
  });

  test('unauthenticated denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'orgs/o1/teams/t1/tasks/tk6', auth: null, data: { title: 'Anon', createdBy: 'anon', assignee: 'anon', status: 'todo' } });
    expect(r.allowed).toBe(false);
  });
});
