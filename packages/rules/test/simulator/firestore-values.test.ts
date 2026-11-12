import { describe, expect, test } from 'bun:test';
import { reviveFirestoreNumbers } from '../../src/simulator/firestore-values.js';
import { RulesFloat } from '../../src/simulator/wrappers/float.js';
import { Reference } from '../../src/simulator/wrappers/reference.js';

describe('reviveFirestoreNumbers', () => {
  test('restores non-integral JSON numbers as Firestore floats', () => {
    const revived = reviveFirestoreNumbers({ price: 1.5, count: 7 }) as {
      price: unknown;
      count: unknown;
    };

    expect(revived.price).toBeInstanceOf(RulesFloat);
    expect(revived.count).toBe(7);
  });

  test('recurses through arrays and plain objects', () => {
    const revived = reviveFirestoreNumbers({ values: [1, { nested: 2.5 }] }) as {
      values: [number, { nested: unknown }];
    };

    expect(revived.values[0]).toBe(1);
    expect(revived.values[1].nested).toBeInstanceOf(RulesFloat);
  });

  test('preserves an explicitly tagged integral double', () => {
    const revived = reviveFirestoreNumbers({ __type: 'float', value: 2 });

    expect(revived).toBeInstanceOf(RulesFloat);
  });

  test('does not traverse class instances', () => {
    const instance = new Date(0);

    expect(reviveFirestoreNumbers(instance)).toBe(instance);
  });

  test('revives serialized DocumentReference objects carrying databaseId while preserving escaped plain maps', () => {
    const namedRef = reviveFirestoreNumbers({
      id: 'org-1',
      path: 'orgs/org-1',
      databaseId: 'analytics',
    });
    expect(namedRef).toBeInstanceOf(Reference);
    expect((namedRef as Reference).path).toBe('orgs/org-1');
    expect((namedRef as Reference).databaseId).toBe('analytics');

    const defaultRef = reviveFirestoreNumbers({
      id: 'org-1',
      path: 'orgs/org-1',
    });
    expect(defaultRef).toBeInstanceOf(Reference);
    expect((defaultRef as Reference).databaseId).toBe('(default)');

    const escapedMap = reviveFirestoreNumbers({
      type: 'pyric/map/1.0',
      fields: { id: 'org-1', path: 'orgs/org-1', databaseId: 'analytics' },
    });
    expect(escapedMap).not.toBeInstanceOf(Reference);
    expect(escapedMap).toEqual({ id: 'org-1', path: 'orgs/org-1', databaseId: 'analytics' });
  });
});
