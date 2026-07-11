/**
 * Scenario 16: Workflow Approval Pipeline
 *
 * Approval flow with changedKeys/addedKeys constraints, unique moveType gates,
 * immutable approval records, and batch operations.
 * Stdlib: auth, transitions, validation, lifecycle
 *
 * Rules: examples/scenarios/16-workflow.rules
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { resolveModules } from 'pyric/rules/internal/node';

const SOURCE = `import { isAuthenticated } from 'auth';
import { validTransition } from 'transitions';
import { hasRequired } from 'validation';
import { fieldUnchanged } from 'lifecycle';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {

    match /requests/{requestId} {
      allow read: if isAuthenticated();

      // Anyone authenticated creates a request with status=pending
      allow create: if isAuthenticated()
          && request.resource.data.status == 'pending'
          && request.resource.data.requesterId == request.auth.uid
          && hasRequired(['title', 'detail', 'status', 'requesterId']);

      // Approve: non-requester, changedKeys only status+approverId+moveType, no addedKeys
      allow update: if isAuthenticated()
          && request.resource.data.moveType == 'approve'
          && resource.data.requesterId != request.auth.uid
          && validTransition('status', 'pending', 'approved')
          && request.resource.data.approverId == request.auth.uid
          && fieldUnchanged('requesterId')
          && fieldUnchanged('title')
          && fieldUnchanged('detail')
          && request.resource.data.diff(resource.data).changedKeys().hasOnly(['status', 'approverId', 'moveType'])
          && request.resource.data.diff(resource.data).addedKeys().hasOnly(['approverId', 'moveType']);

      // Reject: non-requester, changedKeys only status+approverId+moveType
      allow update: if isAuthenticated()
          && request.resource.data.moveType == 'reject'
          && resource.data.requesterId != request.auth.uid
          && validTransition('status', 'pending', 'rejected')
          && request.resource.data.approverId == request.auth.uid
          && fieldUnchanged('requesterId')
          && fieldUnchanged('title')
          && fieldUnchanged('detail')
          && request.resource.data.diff(resource.data).changedKeys().hasOnly(['status', 'approverId', 'moveType'])
          && request.resource.data.diff(resource.data).addedKeys().hasOnly(['approverId', 'moveType']);

      // Cancel: only requester, pending->cancelled
      allow update: if isAuthenticated()
          && request.resource.data.moveType == 'cancel'
          && resource.data.requesterId == request.auth.uid
          && validTransition('status', 'pending', 'cancelled')
          && fieldUnchanged('requesterId')
          && fieldUnchanged('title')
          && fieldUnchanged('detail')
          && request.resource.data.diff(resource.data).changedKeys().hasOnly(['status', 'moveType'])
          && request.resource.data.diff(resource.data).addedKeys().hasOnly(['moveType']);

      allow delete: if false;
    }

    match /approvals/{approvalId} {
      allow read: if isAuthenticated();

      // Create an approval record (immutable)
      allow create: if isAuthenticated()
          && request.resource.data.approverId == request.auth.uid
          && hasRequired(['requestId', 'approverId', 'decision']);

      // Immutable: no updates or deletes
      allow update: if false;
      allow delete: if false;
    }
  }
}`;

const resolved = resolveModules(SOURCE);
if (!resolved.success) throw new Error(resolved.error.message);
const RULES = resolved.data.resolved;

describe('Scenario 16: Workflow Approval Pipeline', () => {
  function makeEnv() {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES,
      documents: {
        'requests/r1': { title: 'New Server', detail: 'Need more capacity', status: 'pending', requesterId: 'alice' },
        'requests/r2': { title: 'Software License', detail: 'IDE license', status: 'pending', requesterId: 'bob' },
        'requests/r3': { title: 'Office Supplies', detail: 'Pens and paper', status: 'pending', requesterId: 'carol' },
        'approvals/a1': { requestId: 'r0', approverId: 'manager1', decision: 'approved' },
      },
    });
    return env;
  }

  // ═══ ALLOW ═══

  test('create request', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'requests/r4', auth: { uid: 'dave' }, data: { title: 'Travel', detail: 'Conference trip', status: 'pending', requesterId: 'dave' } });
    expect(r.allowed).toBe(true);
  });

  test('approve request (changedKeys+addedKeys)', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'requests/r1', auth: { uid: 'manager1' }, data: { title: 'New Server', detail: 'Need more capacity', status: 'approved', requesterId: 'alice', approverId: 'manager1', moveType: 'approve' } });
    expect(r.allowed).toBe(true);
  });

  test('reject request (changedKeys)', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'requests/r2', auth: { uid: 'manager1' }, data: { title: 'Software License', detail: 'IDE license', status: 'rejected', requesterId: 'bob', approverId: 'manager1', moveType: 'reject' } });
    expect(r.allowed).toBe(true);
  });

  test('cancel request', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'requests/r1', auth: { uid: 'alice' }, data: { title: 'New Server', detail: 'Need more capacity', status: 'cancelled', requesterId: 'alice', moveType: 'cancel' } });
    expect(r.allowed).toBe(true);
  });

  test('create approval record', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'approvals/a2', auth: { uid: 'manager1' }, data: { requestId: 'r1', approverId: 'manager1', decision: 'approved' } });
    expect(r.allowed).toBe(true);
  });

  // ═══ DENY ═══

  test('self-approve denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'requests/r1', auth: { uid: 'alice' }, data: { title: 'New Server', detail: 'Need more capacity', status: 'approved', requesterId: 'alice', approverId: 'alice', moveType: 'approve' } });
    expect(r.allowed).toBe(false);
  });

  test('title change during approval denied (changedKeys)', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'requests/r1', auth: { uid: 'manager1' }, data: { title: 'HACKED', detail: 'Need more capacity', status: 'approved', requesterId: 'alice', approverId: 'manager1', moveType: 'approve' } });
    expect(r.allowed).toBe(false);
  });

  test('injected field denied (addedKeys)', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'requests/r1', auth: { uid: 'manager1' }, data: { title: 'New Server', detail: 'Need more capacity', status: 'approved', requesterId: 'alice', approverId: 'manager1', moveType: 'approve', priority: 'urgent' } });
    expect(r.allowed).toBe(false);
  });

  test('non-requester cancel denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'requests/r1', auth: { uid: 'bob' }, data: { title: 'New Server', detail: 'Need more capacity', status: 'cancelled', requesterId: 'alice', moveType: 'cancel' } });
    expect(r.allowed).toBe(false);
  });

  test('detail change during rejection denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'requests/r2', auth: { uid: 'manager1' }, data: { title: 'Software License', detail: 'TAMPERED', status: 'rejected', requesterId: 'bob', approverId: 'manager1', moveType: 'reject' } });
    expect(r.allowed).toBe(false);
  });

  test('spoof approverId denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'requests/r1', auth: { uid: 'manager1' }, data: { title: 'New Server', detail: 'Need more capacity', status: 'approved', requesterId: 'alice', approverId: 'someone_else', moveType: 'approve' } });
    expect(r.allowed).toBe(false);
  });

  test('invalid decision denied (wrong moveType)', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'requests/r1', auth: { uid: 'manager1' }, data: { title: 'New Server', detail: 'Need more capacity', status: 'approved', requesterId: 'alice', approverId: 'manager1', moveType: 'escalate' } });
    expect(r.allowed).toBe(false);
  });

  // ═══ BATCH ═══

  test('batch: approve + create approval atomically', () => {
    const env = makeEnv();
    const r = env.batch([
      { method: 'update', path: 'requests/r1', data: { title: 'New Server', detail: 'Need more capacity', status: 'approved', requesterId: 'alice', approverId: 'manager1', moveType: 'approve' } },
      { method: 'create', path: 'approvals/a3', data: { requestId: 'r1', approverId: 'manager1', decision: 'approved' } },
    ], { uid: 'manager1' });
    expect(r.allowed).toBe(true);
  });

  test('batch rollback when one op fails', () => {
    const env = makeEnv();
    const r = env.batch([
      { method: 'update', path: 'requests/r1', data: { title: 'New Server', detail: 'Need more capacity', status: 'approved', requesterId: 'alice', approverId: 'manager1', moveType: 'approve' } },
      { method: 'create', path: 'approvals/a3', data: { requestId: 'r1', approverId: 'hacker', decision: 'approved' } },
    ], { uid: 'manager1' });
    expect(r.allowed).toBe(false);
  });

  test('verify rollback leaves no orphan docs', () => {
    const env = makeEnv();
    // This batch should fail because the approval has wrong approverId
    env.batch([
      { method: 'update', path: 'requests/r1', data: { title: 'New Server', detail: 'Need more capacity', status: 'approved', requesterId: 'alice', approverId: 'manager1', moveType: 'approve' } },
      { method: 'create', path: 'approvals/a4', data: { requestId: 'r1', approverId: 'hacker', decision: 'approved' } },
    ], { uid: 'manager1' });
    // The request should still be pending (rollback)
    const check = env.execute({ method: 'update', path: 'requests/r1', auth: { uid: 'manager1' }, data: { title: 'New Server', detail: 'Need more capacity', status: 'approved', requesterId: 'alice', approverId: 'manager1', moveType: 'approve' } });
    expect(check.allowed).toBe(true);
  });
});
