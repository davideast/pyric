import { expect, test } from 'bun:test';
import { setRules } from 'pyric/sandbox/firestore';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { buildVerifyFixture } from '../../../src/verify/fixture.js';
import * as client from '../../../src/serve/worker/client.js';
import { makeHostCtx, connectClientToHost, sleep } from './integration-support.js';

const rules = `rules_version = '2'; service cloud.firestore {
  match /databases/{database}/documents {
    match /meets/{id} {
      allow list: if request.query.limit <= 100 && resource.data.visibility == 'public'
        && resource.data.status in resource.data.allowedStatuses;
    }
    match /{document=**} { allow read, write: if false; }
  }
}`;

test('query-proof evidence survives worker reads, listener errors, and captured event JSON (#583)', async () => {
  const previousWorker = globalThis.SharedWorker;
  const ctx = await makeHostCtx();
  const env = getInternalEnv(ctx.sandbox);
  let stop: (() => void) | undefined;
  try {
    setRules(ctx.sandbox, rules);
    const { db } = connectClientToHost(ctx, 'worker://query-proof-diagnostics');
    const q = client.query(client.collection(db, 'meets'),
      client.where('visibility', '==', 'public'),
      client.where('status', 'in', ['scheduled', 'changed']), client.limit(100));
    const expected = { code: 'permission-denied', denialContext: {
      queryProof: { kind: 'unsupported-predicate', failures: [{ rule: { expression: expect.stringContaining('status in') } }] },
    } };
    await expect(client.getDocs(q)).rejects.toMatchObject(expected);
    const errors: unknown[] = [];
    let snapshots = 0;
    stop = client.onSnapshot(q, () => snapshots++, error => errors.push(error));
    await sleep();
    expect(snapshots).toBe(0);
    expect(errors).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(errors[0]))).toMatchObject(expected);
    const capture = JSON.parse(JSON.stringify(buildVerifyFixture({ sandbox: ctx.sandbox, firestoreRules: rules })));
    expect(capture.events).toContainEqual(expect.objectContaining({
      kind: 'request', origin: 'listener', result: 'deny',
      queryProof: expect.objectContaining({ kind: 'unsupported-predicate',
        failures: [expect.objectContaining({ rule: expect.objectContaining({ expression: expect.stringContaining('status in') }) })],
      }),
    }));
    const listener = capture.events.find((event: { kind: string; origin: string }) => event.kind === 'request' && event.origin === 'listener');
    expect(listener.queryProof.query.filters).toContainEqual(expect.objectContaining({
      field: 'status', op: 'in', value: { type: 'wire-value-digest', digest: expect.any(String) },
    }));
    await sleep();
    expect(errors).toHaveLength(1);
  } finally {
    stop?.();
    await sleep();
    env.dispose();
    globalThis.SharedWorker = previousWorker;
  }
});

test('supported finite membership query reaches worker listeners', async () => {
  const previousWorker = globalThis.SharedWorker;
  const ctx = await makeHostCtx();
  let stop: (() => void) | undefined;
  try {
    setRules(ctx.sandbox, rules.replace('resource.data.allowedStatuses', "['scheduled', 'changed']"));
    const { db } = connectClientToHost(ctx, 'worker://query-proof-supported');
    const q = client.query(client.collection(db, 'meets'),
      client.where('visibility', '==', 'public'),
      client.where('status', 'in', ['scheduled', 'changed']), client.limit(100));
    expect((await client.getDocs(q)).empty).toBe(true);
    let snapshots = 0;
    const errors: unknown[] = [];
    stop = client.onSnapshot(q, () => snapshots++, error => errors.push(error));
    await sleep();
    expect(snapshots).toBe(1);
    expect(errors).toHaveLength(0);
  } finally {
    stop?.();
    await sleep();
    getInternalEnv(ctx.sandbox).dispose();
    globalThis.SharedWorker = previousWorker;
  }
});
