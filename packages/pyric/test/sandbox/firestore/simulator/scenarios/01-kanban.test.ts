/**
 * Scenario 1: Task Management (Kanban)
 *
 * Project membership + task status machine + subcollection access via get().
 * Stdlib: transitions, membership, lifecycle
 *
 * Rules: examples/scenarios/01-kanban.rules
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { resolveModules } from 'pyric/rules/internal/node';

const SOURCE = `import { validTransition } from 'transitions';
import { isMemberOf, hasRole } from 'membership';
import { fieldUnchanged } from 'lifecycle';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /projects/{projectId} {
      allow read: if request.auth != null && isMemberOf(resource.data.members);
      allow create: if request.auth != null
          && request.resource.data.owner == request.auth.uid
          && request.auth.uid in request.resource.data.members;
      allow update: if request.auth != null && hasRole(resource.data.members, 'admin');
      allow delete: if request.auth != null && resource.data.owner == request.auth.uid;

      match /tasks/{taskId} {
        allow read: if request.auth != null
            && isMemberOf(get(/databases/$(database)/documents/projects/$(projectId)).data.members);
        allow create: if request.auth != null
            && isMemberOf(get(/databases/$(database)/documents/projects/$(projectId)).data.members)
            && request.resource.data.createdBy == request.auth.uid
            && request.resource.data.status == 'todo';
        allow update: if request.auth != null
            && isMemberOf(get(/databases/$(database)/documents/projects/$(projectId)).data.members)
            && fieldUnchanged('createdBy')
            && ((validTransition('status', 'todo', 'doing') && request.resource.data.assignee == request.auth.uid)
                || validTransition('status', 'doing', 'done')
                || (validTransition('status', 'done', 'archived')
                    && hasRole(get(/databases/$(database)/documents/projects/$(projectId)).data.members, 'admin'))
                || (request.resource.data.status == resource.data.status));
        allow delete: if request.auth != null
            && hasRole(get(/databases/$(database)/documents/projects/$(projectId)).data.members, 'admin');
      }
    }
  }
}`;

const resolved = resolveModules(SOURCE);
if (!resolved.success) throw new Error(resolved.error.message);
const RULES = resolved.data.resolved;

describe('Scenario 1: Kanban Task Management', () => {
  function makeEnv() {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES,
      documents: {
        'projects/p1': { owner: 'alice', name: 'Alpha', members: { alice: 'admin', bob: 'editor', carol: 'viewer' } },
        'projects/p1/tasks/t1': { title: 'Design', status: 'todo', assignee: 'bob', createdBy: 'bob' },
        'projects/p1/tasks/t2': { title: 'Tests', status: 'doing', assignee: 'carol', createdBy: 'carol' },
        'projects/p1/tasks/t3': { title: 'Deploy', status: 'done', assignee: 'alice', createdBy: 'alice' },
      },
    });
    return env;
  }

  test('member creates task', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'projects/p1/tasks/t4', auth: { uid: 'bob' }, data: { title: 'New', status: 'todo', assignee: 'bob', createdBy: 'bob' } });
    expect(r.allowed).toBe(true);
  });

  test('assignee moves todo→doing', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'projects/p1/tasks/t1', auth: { uid: 'bob' }, data: { title: 'Design', status: 'doing', assignee: 'bob', createdBy: 'bob' } });
    expect(r.allowed).toBe(true);
  });

  test('any member moves doing→done', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'projects/p1/tasks/t2', auth: { uid: 'alice' }, data: { title: 'Tests', status: 'done', assignee: 'carol', createdBy: 'carol' } });
    expect(r.allowed).toBe(true);
  });

  test('admin archives done→archived', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'projects/p1/tasks/t3', auth: { uid: 'alice' }, data: { title: 'Deploy', status: 'archived', assignee: 'alice', createdBy: 'alice' } });
    expect(r.allowed).toBe(true);
  });

  test('non-assignee cannot move todo→doing', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'projects/p1/tasks/t1', auth: { uid: 'carol' }, data: { title: 'Design', status: 'doing', assignee: 'bob', createdBy: 'bob' } });
    expect(r.allowed).toBe(false);
  });

  test('cannot skip status todo→done', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'projects/p1/tasks/t1', auth: { uid: 'bob' }, data: { title: 'Design', status: 'done', assignee: 'bob', createdBy: 'bob' } });
    expect(r.allowed).toBe(false);
  });

  test('createdBy tamper denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'projects/p1/tasks/t1', auth: { uid: 'bob' }, data: { title: 'Design', status: 'doing', assignee: 'bob', createdBy: 'alice' } });
    expect(r.allowed).toBe(false);
  });

  test('non-member cannot create task', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'projects/p1/tasks/t5', auth: { uid: 'dave' }, data: { title: 'Hack', status: 'todo', assignee: 'dave', createdBy: 'dave' } });
    expect(r.allowed).toBe(false);
  });
});
