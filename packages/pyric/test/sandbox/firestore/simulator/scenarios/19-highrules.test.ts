/**
 * Scenario 19: 12-Rule Stress
 *
 * 12 unique moveType-gated status transitions on a single collection,
 * each with fieldUnchanged('createdBy'). Tests forward paths, alternative
 * paths, and denial conditions.
 * Stdlib: auth, transitions, lifecycle
 *
 * Rules: examples/scenarios/19-highrules.rules
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { resolveModules } from 'pyric/rules/node';

const SOURCE = `import { isAuthenticated } from 'auth';
import { validTransition } from 'transitions';
import { fieldUnchanged } from 'lifecycle';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orders/{orderId} {
      allow read: if isAuthenticated();

      allow create: if isAuthenticated()
          && request.resource.data.status == 'draft'
          && request.resource.data.createdBy == request.auth.uid;

      // 1. submit: draft -> submitted (creator only)
      allow update: if isAuthenticated()
          && request.resource.data.moveType == 'submit'
          && resource.data.createdBy == request.auth.uid
          && validTransition('status', 'draft', 'submitted')
          && fieldUnchanged('createdBy');

      // 2. review: submitted -> review
      allow update: if isAuthenticated()
          && request.resource.data.moveType == 'review'
          && validTransition('status', 'submitted', 'review')
          && fieldUnchanged('createdBy');

      // 3. approve: review -> approved
      allow update: if isAuthenticated()
          && request.resource.data.moveType == 'approve'
          && validTransition('status', 'review', 'approved')
          && fieldUnchanged('createdBy');

      // 4. process: approved -> processing
      allow update: if isAuthenticated()
          && request.resource.data.moveType == 'process'
          && validTransition('status', 'approved', 'processing')
          && fieldUnchanged('createdBy');

      // 5. ship: processing -> shipped
      allow update: if isAuthenticated()
          && request.resource.data.moveType == 'ship'
          && validTransition('status', 'processing', 'shipped')
          && fieldUnchanged('createdBy');

      // 6. deliver: shipped -> delivered
      allow update: if isAuthenticated()
          && request.resource.data.moveType == 'deliver'
          && validTransition('status', 'shipped', 'delivered')
          && fieldUnchanged('createdBy');

      // 7. complete: delivered -> completed
      allow update: if isAuthenticated()
          && request.resource.data.moveType == 'complete'
          && validTransition('status', 'delivered', 'completed')
          && fieldUnchanged('createdBy');

      // 8. cancel: draft -> cancelled (creator only)
      allow update: if isAuthenticated()
          && request.resource.data.moveType == 'cancel'
          && resource.data.createdBy == request.auth.uid
          && validTransition('status', 'draft', 'cancelled')
          && fieldUnchanged('createdBy');

      // 9. reject: submitted -> rejected
      allow update: if isAuthenticated()
          && request.resource.data.moveType == 'reject'
          && validTransition('status', 'submitted', 'rejected')
          && fieldUnchanged('createdBy');

      // 10. return: review -> submitted
      allow update: if isAuthenticated()
          && request.resource.data.moveType == 'return'
          && validTransition('status', 'review', 'submitted')
          && fieldUnchanged('createdBy');

      // 11. pause: processing -> paused
      allow update: if isAuthenticated()
          && request.resource.data.moveType == 'pause'
          && validTransition('status', 'processing', 'paused')
          && fieldUnchanged('createdBy');

      // 12. resume: paused -> processing
      allow update: if isAuthenticated()
          && request.resource.data.moveType == 'resume'
          && validTransition('status', 'paused', 'processing')
          && fieldUnchanged('createdBy');

      allow delete: if false;
    }
  }
}`;

const resolved = resolveModules(SOURCE);
if (!resolved.success) throw new Error(resolved.error.message);
const RULES = resolved.data.resolved;

describe('Scenario 19: 12-Rule Stress', () => {
  function makeEnv() {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES,
      documents: {
        'orders/o1': { status: 'draft', createdBy: 'alice', title: 'Order A' },
        'orders/o2': { status: 'submitted', createdBy: 'alice', title: 'Order B' },
        'orders/o3': { status: 'review', createdBy: 'bob', title: 'Order C' },
        'orders/o4': { status: 'approved', createdBy: 'bob', title: 'Order D' },
        'orders/o5': { status: 'processing', createdBy: 'carol', title: 'Order E' },
        'orders/o6': { status: 'shipped', createdBy: 'carol', title: 'Order F' },
        'orders/o7': { status: 'delivered', createdBy: 'dave', title: 'Order G' },
        'orders/o8': { status: 'paused', createdBy: 'carol', title: 'Order H' },
      },
    });
    return env;
  }

  // ═══ ALL 12 TRANSITIONS ═══

  test('1. submit: draft -> submitted', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'orders/o1', auth: { uid: 'alice' }, data: { status: 'submitted', createdBy: 'alice', title: 'Order A', moveType: 'submit' } });
    expect(r.allowed).toBe(true);
  });

  test('2. review: submitted -> review', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'orders/o2', auth: { uid: 'reviewer1' }, data: { status: 'review', createdBy: 'alice', title: 'Order B', moveType: 'review' } });
    expect(r.allowed).toBe(true);
  });

  test('3. approve: review -> approved', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'orders/o3', auth: { uid: 'approver1' }, data: { status: 'approved', createdBy: 'bob', title: 'Order C', moveType: 'approve' } });
    expect(r.allowed).toBe(true);
  });

  test('4. process: approved -> processing', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'orders/o4', auth: { uid: 'processor1' }, data: { status: 'processing', createdBy: 'bob', title: 'Order D', moveType: 'process' } });
    expect(r.allowed).toBe(true);
  });

  test('5. ship: processing -> shipped', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'orders/o5', auth: { uid: 'shipper1' }, data: { status: 'shipped', createdBy: 'carol', title: 'Order E', moveType: 'ship' } });
    expect(r.allowed).toBe(true);
  });

  test('6. deliver: shipped -> delivered', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'orders/o6', auth: { uid: 'driver1' }, data: { status: 'delivered', createdBy: 'carol', title: 'Order F', moveType: 'deliver' } });
    expect(r.allowed).toBe(true);
  });

  test('7. complete: delivered -> completed', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'orders/o7', auth: { uid: 'closer1' }, data: { status: 'completed', createdBy: 'dave', title: 'Order G', moveType: 'complete' } });
    expect(r.allowed).toBe(true);
  });

  test('8. cancel: draft -> cancelled (creator)', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'orders/o1', auth: { uid: 'alice' }, data: { status: 'cancelled', createdBy: 'alice', title: 'Order A', moveType: 'cancel' } });
    expect(r.allowed).toBe(true);
  });

  test('9. reject: submitted -> rejected', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'orders/o2', auth: { uid: 'reviewer1' }, data: { status: 'rejected', createdBy: 'alice', title: 'Order B', moveType: 'reject' } });
    expect(r.allowed).toBe(true);
  });

  test('10. return: review -> submitted', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'orders/o3', auth: { uid: 'approver1' }, data: { status: 'submitted', createdBy: 'bob', title: 'Order C', moveType: 'return' } });
    expect(r.allowed).toBe(true);
  });

  test('11. pause: processing -> paused', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'orders/o5', auth: { uid: 'processor1' }, data: { status: 'paused', createdBy: 'carol', title: 'Order E', moveType: 'pause' } });
    expect(r.allowed).toBe(true);
  });

  test('12. resume: paused -> processing', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'orders/o8', auth: { uid: 'processor1' }, data: { status: 'processing', createdBy: 'carol', title: 'Order H', moveType: 'resume' } });
    expect(r.allowed).toBe(true);
  });

  // ═══ DENY ═══

  test('skip status denied (draft -> approved)', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'orders/o1', auth: { uid: 'alice' }, data: { status: 'approved', createdBy: 'alice', title: 'Order A', moveType: 'approve' } });
    expect(r.allowed).toBe(false);
  });

  test('non-creator cancel denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'orders/o1', auth: { uid: 'bob' }, data: { status: 'cancelled', createdBy: 'alice', title: 'Order A', moveType: 'cancel' } });
    expect(r.allowed).toBe(false);
  });

  test('createdBy tamper denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'orders/o2', auth: { uid: 'reviewer1' }, data: { status: 'review', createdBy: 'hacker', title: 'Order B', moveType: 'review' } });
    expect(r.allowed).toBe(false);
  });

  test('wrong moveType denied', () => {
    const env = makeEnv();
    // Trying to use 'approve' moveType on a submitted order (should be 'review')
    const r = env.execute({ method: 'update', path: 'orders/o2', auth: { uid: 'reviewer1' }, data: { status: 'review', createdBy: 'alice', title: 'Order B', moveType: 'approve' } });
    expect(r.allowed).toBe(false);
  });

  test('unauthenticated denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'orders/o1', auth: null, data: { status: 'submitted', createdBy: 'alice', title: 'Order A', moveType: 'submit' } });
    expect(r.allowed).toBe(false);
  });

  test('delete blocked', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'delete', path: 'orders/o1', auth: { uid: 'alice' } });
    expect(r.allowed).toBe(false);
  });
});
