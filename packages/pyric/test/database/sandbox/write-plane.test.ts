import { expect, it } from 'bun:test';
import { BackendState } from '../../../src/database/sandbox/backend-state.js';
import { ChildListeners } from '../../../src/database/sandbox/child-listeners.js';
import { ValueListeners } from '../../../src/database/sandbox/value-listeners.js';
import { WritePlane } from '../../../src/database/sandbox/write-plane.js';

it('normalizes admin writes, resolves increments, and publishes snapshots', () => {
  const state = new BackendState();
  const writes = new WritePlane(state, new ValueListeners(state), new ChildListeners(state));
  writes.adminSet('/count', 2);
  writes.adminSet('/count', { '.sv': { increment: 3 } });
  expect(writes.adminGet('/count')).toBe(5);
  writes.adminUpdate('/items', { a: 1, b: 2 });
  expect(writes.snapshotState()).toEqual({ count: 5, items: { a: 1, b: 2 } });
});

it('a multi-path update that a rule denies records no allow for the paths it checked first', () => {
  const state = new BackendState();
  state.rules.setRules({ rules: { allowed: { '.write': true }, denied: { '.write': false } } });
  const writes = new WritePlane(state, new ValueListeners(state), new ChildListeners(state));
  const recorded: Array<{ path: string; result: string }> = [];
  const operation = state.events.operation.bind(state.events);
  state.events.operation = (auth, method, path, result, evaluation, fields) => {
    recorded.push({ path, result });
    operation(auth, method, path, result, evaluation, fields);
  };

  expect(() => writes.update({ uid: 'u1' }, '/', { allowed: 'ok', denied: 'no' })).toThrow('PERMISSION_DENIED');
  expect(recorded).toEqual([{ path: '/denied', result: 'deny' }]);

  recorded.length = 0;
  writes.update({ uid: 'u1' }, '/', { allowed: 'ok' });
  expect(recorded).toEqual([{ path: '/allowed', result: 'allow' }]);
});

it('re-evaluates only listeners whose .read rules can depend on the written paths', () => {
  const state = new BackendState();
  const values = new ValueListeners(state);
  const children = new ChildListeners(state);
  const writes = new WritePlane(state, values, children);

  writes.adminSet('/rooms/r1', { members: { alice: true }, msg: 'hi-1' });
  writes.adminSet('/rooms/r2', { members: { bob: true }, msg: 'hi-2' });
  writes.adminSet('/authOnly', 'public-to-signed-in');
  writes.setRules({
    rules: {
      rooms: {
        $room: {
          '.read': "data.child('members').child(auth.uid).val() == true",
        },
      },
      authOnly: {
        '.read': 'auth != null',
      },
    },
  });

  const aliceCanceled: string[] = [];
  const bobCanceled: string[] = [];
  const authOnlyCanceled: string[] = [];
  values.onValue(
    { uid: 'alice' },
    '/rooms/r1/msg',
    () => {},
    undefined,
    (err) => aliceCanceled.push((err as Error & { code: string }).code),
  );
  values.onValue(
    { uid: 'bob' },
    '/rooms/r2/msg',
    () => {},
    undefined,
    (err) => bobCanceled.push((err as Error & { code: string }).code),
  );
  values.onValue(
    { uid: 'alice' },
    '/authOnly',
    () => {},
    undefined,
    (err) => authOnlyCanceled.push((err as Error & { code: string }).code),
  );

  const readEvalPaths: string[] = [];
  const evaluate = state.rules.evaluate.bind(state.rules);
  state.rules.evaluate = (operation, path, ctx) => {
    if (operation === 'read') readEvalPaths.push(path);
    return evaluate(operation, path, ctx);
  };

  // Writing to an unrelated path or auth-only subtree does not re-evaluate any listener.
  writes.adminSet('/authOnly', 'updated');
  expect(readEvalPaths).toEqual([]);

  // Writing under /rooms/r1 only re-evaluates the listener under /rooms/r1, not /rooms/r2 or /authOnly.
  writes.adminRemove('/rooms/r1/members/alice');
  expect(readEvalPaths).toEqual(['/rooms/r1/msg']);
  expect(aliceCanceled).toEqual(['PERMISSION_DENIED']);
  expect(bobCanceled).toEqual([]);
  expect(authOnlyCanceled).toEqual([]);
});
