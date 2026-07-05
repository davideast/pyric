/**
 * Scenario 20: 3-Level Subcollections
 *
 * Org -> Team -> Task hierarchy with parent/grandparent get() lookups,
 * role-based access at each level, and field immutability.
 * Stdlib: auth, membership, lifecycle, validation
 *
 * Rules: examples/scenarios/20-nested.rules
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { resolveModules } from 'pyric/rules/node';

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
        // Org membership required for all team access
        allow read: if isAuthenticated()
            && isMemberOf(get(/databases/$(database)/documents/orgs/$(orgId)).data.members);

        // Only org admin creates teams
        allow create: if isAuthenticated()
            && hasRole(get(/databases/$(database)/documents/orgs/$(orgId)).data.members, 'admin')
            && hasRequired(['name', 'members', 'lead']);

        // Only team lead updates team
        allow update: if isAuthenticated()
            && isMemberOf(get(/databases/$(database)/documents/orgs/$(orgId)).data.members)
            && resource.data.lead == request.auth.uid;

        // Only org admin deletes teams
        allow delete: if isAuthenticated()
            && hasRole(get(/databases/$(database)/documents/orgs/$(orgId)).data.members, 'admin');

        match /tasks/{taskId} {
          // Team membership required (plus org membership)
          allow read: if isAuthenticated()
              && isMemberOf(get(/databases/$(database)/documents/orgs/$(orgId)).data.members)
              && isMemberOf(get(/databases/$(database)/documents/orgs/$(orgId)/teams/$(teamId)).data.members);

          // Team members create tasks
          allow create: if isAuthenticated()
              && isMemberOf(get(/databases/$(database)/documents/orgs/$(orgId)).data.members)
              && isMemberOf(get(/databases/$(database)/documents/orgs/$(orgId)/teams/$(teamId)).data.members)
              && request.resource.data.createdBy == request.auth.uid
              && hasRequired(['title', 'createdBy', 'assignee', 'status']);

          // Assignee or creator can update, createdBy immutable
          allow update: if isAuthenticated()
              && isMemberOf(get(/databases/$(database)/documents/orgs/$(orgId)).data.members)
              && isMemberOf(get(/databases/$(database)/documents/orgs/$(orgId)/teams/$(teamId)).data.members)
              && (resource.data.assignee == request.auth.uid
                  || resource.data.createdBy == request.auth.uid)
              && fieldUnchanged('createdBy');

          // Only org admin deletes tasks
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

describe('Scenario 20: 3-Level Subcollections', () => {
  function makeEnv() {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES,
      documents: {
        'orgs/o1': { name: 'Acme Corp', members: { alice: 'admin', bob: 'member', carol: 'member', dave: 'member' } },
        'orgs/o1/teams/t1': { name: 'Engineering', members: { bob: 'dev', carol: 'dev' }, lead: 'bob' },
        'orgs/o1/teams/t1/tasks/tk1': { title: 'Build API', createdBy: 'bob', assignee: 'carol', status: 'doing' },
        'orgs/o1/teams/t1/tasks/tk2': { title: 'Write Tests', createdBy: 'carol', assignee: 'bob', status: 'todo' },
        'orgs/o1/teams/t2': { name: 'Design', members: { dave: 'designer' }, lead: 'dave' },
      },
    });
    return env;
  }

  // ═══ ALLOW ═══

  test('admin creates team', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'orgs/o1/teams/t3', auth: { uid: 'alice' }, data: { name: 'Marketing', members: { alice: 'manager' }, lead: 'alice' } });
    expect(r.allowed).toBe(true);
  });

  test('team member creates task', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'orgs/o1/teams/t1/tasks/tk3', auth: { uid: 'bob' }, data: { title: 'Deploy', createdBy: 'bob', assignee: 'carol', status: 'todo' } });
    expect(r.allowed).toBe(true);
  });

  test('assignee updates task', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'orgs/o1/teams/t1/tasks/tk1', auth: { uid: 'carol' }, data: { title: 'Build API v2', createdBy: 'bob', assignee: 'carol', status: 'done' } });
    expect(r.allowed).toBe(true);
  });

  test('creator updates task', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'orgs/o1/teams/t1/tasks/tk1', auth: { uid: 'bob' }, data: { title: 'Build API v2', createdBy: 'bob', assignee: 'carol', status: 'done' } });
    expect(r.allowed).toBe(true);
  });

  test('lead updates team', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'orgs/o1/teams/t1', auth: { uid: 'bob' }, data: { name: 'Engineering (Renamed)', members: { bob: 'dev', carol: 'dev' }, lead: 'bob' } });
    expect(r.allowed).toBe(true);
  });

  test('admin deletes team', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'delete', path: 'orgs/o1/teams/t2', auth: { uid: 'alice' } });
    expect(r.allowed).toBe(true);
  });

  test('admin deletes task', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'delete', path: 'orgs/o1/teams/t1/tasks/tk1', auth: { uid: 'alice' } });
    expect(r.allowed).toBe(true);
  });

  // ═══ DENY ═══

  test('non-org-member denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'orgs/o1/teams/t1/tasks/tk4', auth: { uid: 'eve' }, data: { title: 'Hack', createdBy: 'eve', assignee: 'eve', status: 'todo' } });
    expect(r.allowed).toBe(false);
  });

  test('non-team-member denied (even if org member)', () => {
    const env = makeEnv();
    // dave is in org but not in team t1
    const r = env.execute({ method: 'create', path: 'orgs/o1/teams/t1/tasks/tk5', auth: { uid: 'dave' }, data: { title: 'Intrude', createdBy: 'dave', assignee: 'dave', status: 'todo' } });
    expect(r.allowed).toBe(false);
  });

  test('non-assignee/creator denied', () => {
    const env = makeEnv();
    // carol is in the team but is neither assignee nor creator of tk2 (creator=carol, assignee=bob)
    // Actually carol IS creator of tk2. Let's use a different scenario:
    // tk1: createdBy=bob, assignee=carol. So dave (who is not in team t1) can't update.
    // But we need someone in the team who is neither. bob/carol are the only team members
    // and for tk1 bob=creator carol=assignee. Let's test with alice (org admin but not team member)
    const r = env.execute({ method: 'update', path: 'orgs/o1/teams/t1/tasks/tk1', auth: { uid: 'alice' }, data: { title: 'Tampered', createdBy: 'bob', assignee: 'carol', status: 'done' } });
    expect(r.allowed).toBe(false);
  });

  test('non-admin delete denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'delete', path: 'orgs/o1/teams/t1/tasks/tk1', auth: { uid: 'bob' } });
    expect(r.allowed).toBe(false);
  });

  test('createdBy tamper denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'orgs/o1/teams/t1/tasks/tk1', auth: { uid: 'carol' }, data: { title: 'Build API', createdBy: 'carol', assignee: 'carol', status: 'doing' } });
    expect(r.allowed).toBe(false);
  });

  test('non-lead team update denied', () => {
    const env = makeEnv();
    // carol is in team t1 but is not the lead (bob is)
    const r = env.execute({ method: 'update', path: 'orgs/o1/teams/t1', auth: { uid: 'carol' }, data: { name: 'Hacked Team', members: { bob: 'dev', carol: 'dev' }, lead: 'bob' } });
    expect(r.allowed).toBe(false);
  });

  test('outsider at 3rd level denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'orgs/o1/teams/t1/tasks/tk1', auth: { uid: 'stranger' }, data: { title: 'Hacked', createdBy: 'bob', assignee: 'carol', status: 'done' } });
    expect(r.allowed).toBe(false);
  });

  test('unauthenticated denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'orgs/o1/teams/t1/tasks/tk6', auth: null, data: { title: 'Anon', createdBy: 'anon', assignee: 'anon', status: 'todo' } });
    expect(r.allowed).toBe(false);
  });
});
