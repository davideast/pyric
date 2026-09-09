/**
 * Tests for the cross-service state diff.
 *
 * The contract under test: every difference between two full states is
 * reported once, tagged with the service it concerns, at the granularity the
 * promotion writes. Documents, objects, and accounts report field by field;
 * the Realtime Database tree reports at the shallowest path that differs; the
 * three rule sources report under their own service names.
 */
import { describe, it, expect } from 'bun:test';

import {
  AUTH_PROVIDER_CONFIG_PATH,
  DATABASE_PRIORITY_FIELD,
  databasePrioritiesOf,
  databaseTreeOf,
  diffFullStates,
  diffTrees,
  jsonEqual,
} from '../../../src/sandbox/branches/state-diff.js';
import type { FullSandboxState } from '../../../src/sandbox/full-state.js';

/** An empty state, with `overrides` written over it. */
function state(overrides: Partial<FullSandboxState> = {}): FullSandboxState {
  return {
    firestore: {},
    database: null,
    storage: [],
    auth: { users: [], providers: {} },
    rules: { firestore: '', database: null, storage: null },
    ...overrides,
  };
}

/** The Realtime Database persistence envelope, as the backend exports it. */
function envelope(data: unknown, priorities: Record<string, unknown> = {}) {
  return { '.pyricRtdbPersistence': 1, data, priorities } as FullSandboxState['database'];
}

describe('jsonEqual', () => {
  it('holds for structurally identical values and fails on any difference', () => {
    expect(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(jsonEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(jsonEqual([1], { 0: 1 })).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
  });
});

describe('the Realtime Database envelope readers', () => {
  it('read the tree and the priorities out of a persistence envelope', () => {
    const carried = state({ database: envelope({ rooms: { one: 1 } }, { 'rooms/one': 5 }) });
    expect(databaseTreeOf(carried)).toEqual({ rooms: { one: 1 } });
    expect(databasePrioritiesOf(carried)).toEqual({ 'rooms/one': 5 });
  });

  it('read a value that is not an envelope as the tree itself', () => {
    expect(databaseTreeOf(state({ database: { rooms: 1 } }))).toEqual({ rooms: 1 });
    expect(databasePrioritiesOf(state({ database: { rooms: 1 } }))).toEqual({});
  });
});

describe('diffTrees', () => {
  it('reports each change at the shallowest path that differs', () => {
    expect(diffTrees({ a: { b: 1, c: 2 } }, { a: { b: 9, c: 2 } })).toEqual([
      { path: 'a/b', before: 1, after: 9 },
    ]);
  });

  it('reports a whole subtree when one side is not an object', () => {
    expect(diffTrees({ a: { b: 1 } }, { a: 5 })).toEqual([
      { path: 'a', before: { b: 1 }, after: 5 },
    ]);
  });

  it('reports the root when the whole tree is replaced', () => {
    expect(diffTrees(null, { a: 1 })).toEqual([{ path: '/', before: null, after: { a: 1 } }]);
  });

  it('reports nothing for equal trees', () => {
    expect(diffTrees({ a: { b: 1 } }, { a: { b: 1 } })).toEqual([]);
  });
});

describe('diffFullStates', () => {
  it('reports nothing when the two states are the same', () => {
    expect(diffFullStates(state(), state())).toEqual([]);
  });

  it('reports a Firestore change field by field, with a dotted leaf path', () => {
    const before = state({ firestore: { 'things/a': { v: 1, kept: true } } });
    const after = state({ firestore: { 'things/a': { v: 2, kept: true } } });
    expect(diffFullStates(before, after)).toEqual([
      { kind: 'real-divergence', service: 'firestore', path: 'things/a', field: 'v', before: 1, after: 2 },
    ]);
  });

  it('reports an added or removed document at the document path, with no field', () => {
    const added = diffFullStates(state(), state({ firestore: { 'things/a': { v: 1 } } }));
    expect(added).toEqual([
      {
        kind: 'real-divergence',
        service: 'firestore',
        path: 'things/a',
        before: undefined,
        after: { v: 1 },
      },
    ]);
    const removed = diffFullStates(state({ firestore: { 'things/a': { v: 1 } } }), state());
    expect(removed[0]!.after).toBeUndefined();
  });

  it('reports a nested array element with a bracketed leaf path', () => {
    const before = state({ firestore: { 'things/a': { tags: ['x', 'y'] } } });
    const after = state({ firestore: { 'things/a': { tags: ['x', 'z'] } } });
    expect(diffFullStates(before, after)[0]).toMatchObject({ field: 'tags[1]', after: 'z' });
  });

  it('reports a Realtime Database priority under its own field name', () => {
    const before = state({ database: envelope({ rooms: 1 }, { rooms: 1 }) });
    const after = state({ database: envelope({ rooms: 1 }, { rooms: 7 }) });
    expect(diffFullStates(before, after)).toEqual([
      {
        kind: 'real-divergence',
        service: 'database',
        path: 'rooms',
        field: DATABASE_PRIORITY_FIELD,
        before: 1,
        after: 7,
      },
    ]);
  });

  it('reports a Storage object field by field and a missing object at its path', () => {
    const object = { path: 'docs/a.txt', contentBase64: 'AQ==', customMetadata: {} };
    const changed = diffFullStates(
      state({ storage: [object] }),
      state({ storage: [{ ...object, contentBase64: 'Ag==' }] }),
    );
    expect(changed).toEqual([
      {
        kind: 'real-divergence',
        service: 'storage',
        path: 'docs/a.txt',
        field: 'contentBase64',
        before: 'AQ==',
        after: 'Ag==',
      },
    ]);
    expect(diffFullStates(state({ storage: [object] }), state())[0]).toMatchObject({
      service: 'storage',
      path: 'docs/a.txt',
      after: undefined,
    });
  });

  it('reports an auth account under its uid and a provider under the config path', () => {
    const user = { uid: 'alice', email: 'alice@example.com' };
    const changed = diffFullStates(
      state({ auth: { users: [user], providers: { password: true } } }),
      state({ auth: { users: [{ ...user, disabled: true }], providers: { password: false } } }),
    );
    expect(changed).toEqual([
      {
        kind: 'real-divergence',
        service: 'auth',
        path: 'alice',
        field: 'disabled',
        before: undefined,
        after: true,
      },
      {
        kind: 'real-divergence',
        service: 'auth',
        path: AUTH_PROVIDER_CONFIG_PATH,
        field: 'password',
        before: true,
        after: false,
      },
    ]);
  });

  it('reports each rule source under its own service name as the path', () => {
    const before = state();
    const after = state({
      rules: { firestore: 'allow', database: { rules: {} }, storage: 'allow' },
    });
    expect(diffFullStates(before, after).map((divergence) => divergence.path)).toEqual([
      'firestore',
      'database',
      'storage',
    ]);
    for (const divergence of diffFullStates(before, after)) {
      expect(divergence.service).toBe('rules');
    }
  });

  it('orders the services Firestore, database, Storage, auth, rules', () => {
    const before = state();
    const after = state({
      firestore: { 'things/a': { v: 1 } },
      database: envelope({ rooms: 1 }),
      storage: [{ path: 'docs/a.txt', contentBase64: 'AQ==', customMetadata: {} }],
      auth: { users: [{ uid: 'alice' }], providers: {} },
      rules: { firestore: 'allow', database: null, storage: null },
    });
    expect(diffFullStates(before, after).map((divergence) => divergence.service)).toEqual([
      'firestore',
      'database',
      'storage',
      'auth',
      'rules',
    ]);
  });
});
