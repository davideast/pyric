import { describe, expect, test } from 'bun:test';
import { reviveFirestoreNumbers } from '../../src/simulator/firestore-values.js';
import { RulesFloat } from '../../src/simulator/wrappers/float.js';
import { Reference } from '../../src/simulator/wrappers/reference.js';
import { encodeWireDocument } from '../../src/test/wire-values.js';

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

  test('recurses into unescaped user maps so -0 and >=2^53 preserve float typing', () => {
    const unescapedTag = Symbol.for('pyric.unescapedMap');
    const unescapedMap: Record<string, unknown> = {
      type: 'pyric/map/1.0',
      fields: { negZero: -0, huge: 2 ** 53 },
    };
    Object.defineProperty(unescapedMap, unescapedTag, { value: true });

    const revived = reviveFirestoreNumbers(unescapedMap) as Record<string, unknown>;
    expect(revived.type).toBe('pyric/map/1.0');
    expect((revived as Record<symbol, unknown>)[unescapedTag]).toBe(true);
    const fields = revived.fields as Record<string, unknown>;
    expect(fields.negZero).toBeInstanceOf(RulesFloat);
    expect(Object.is((fields.negZero as RulesFloat).value, -0)).toBe(true);
    expect(fields.huge).toBeInstanceOf(RulesFloat);
    expect((fields.huge as RulesFloat).value).toBe(2 ** 53);
  });

  test('encodes Reference wire paths using each reference databaseId', () => {
    const doc = encodeWireDocument(
      {
        defaultRef: new Reference('users/u1'),
        namedRef: new Reference('orgs/o1', 'tenant-db'),
        rootNamedRef: new Reference('', 'tenant-db'),
      },
      'data',
    );
    expect(doc.defaultRef).toBe('/databases/(default)/documents/users/u1');
    expect(doc.namedRef).toBe('/databases/tenant-db/documents/orgs/o1');
    expect(doc.rootNamedRef).toBe('/databases/tenant-db/documents');
  });
});
