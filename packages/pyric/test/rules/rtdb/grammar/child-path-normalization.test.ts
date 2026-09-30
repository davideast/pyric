import { describe, test, expect } from 'bun:test';
import { DataSnapshot } from '../../../../src/rules/rtdb/grammar/simulator.js';

describe('04-rtdb-datasnapshot-child-path-normalization', () => {
  test('DataSnapshot.child normalizes . and .. path segments', () => {
    const root = new DataSnapshot(
      {
        users: {
          alice: { name: 'Alice' },
          bob: { name: 'Bob' },
        },
      },
      '/',
      null,
    );

    expect(root.child('users/./alice').val()).toEqual({ name: 'Alice' });
    expect(root.child('users/alice/./name').val()).toBe('Alice');
    expect(root.child('users/alice/../bob/name').val()).toBe('Bob');
    expect(root.child('users/alice/../../users/bob/name').val()).toBe('Bob');
  });
});
