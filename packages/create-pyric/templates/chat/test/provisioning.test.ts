import assert from 'node:assert/strict';
import test from 'node:test';
import { createProvisioner } from '../src/services/provisioning.ts';

const user = { uid: 'user-1' };

test('concurrent callers share one attempt and both observe its failure', async () => {
  let runs = 0;
  let reject: (reason: Error) => void = () => undefined;
  const provision = createProvisioner(() => {
    runs += 1;
    return new Promise<void>((_resolve, nextReject) => {
      reject = nextReject;
    });
  });

  const observerAttempt = provision(user);
  const signInAttempt = provision(user);
  assert.equal(runs, 1);

  reject(new Error('presence write denied'));
  await assert.rejects(observerAttempt, /presence write denied/);
  await assert.rejects(signInAttempt, /presence write denied/);
});

test('a failed attempt is forgotten so the next sign-in retries', async () => {
  let runs = 0;
  const provision = createProvisioner(() => {
    runs += 1;
    return runs === 1 ? Promise.reject(new Error('offline')) : Promise.resolve();
  });

  await assert.rejects(provision(user), /offline/);
  await provision(user);
  assert.equal(runs, 2);
});

test('a successful attempt is cached per user', async () => {
  let runs = 0;
  const provision = createProvisioner(() => {
    runs += 1;
    return Promise.resolve();
  });

  await provision(user);
  await provision(user);
  await provision({ uid: 'user-2' });
  assert.equal(runs, 2);
});
