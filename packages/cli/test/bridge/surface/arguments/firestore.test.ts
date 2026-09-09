/**
 * The `firestore` tool's argument vocabulary: segment-parity path checks, the
 * `getDocs` constraint list (each constraint's shape and the inequality
 * ordering rule), the data-plane call one collection read builds, and the
 * per-write shape a batch requires.
 */
import { describe, expect, it } from 'bun:test';

import {
  checkBatch,
  checkCollectionPath,
  checkConstraints,
  checkDocumentPath,
  collectionRead,
  constraintsOf,
  RENAMES,
} from '../../../../src/bridge/surface/arguments/firestore.js';
import { failFor } from '../../../../src/bridge/surface/method-validation.js';

const failDoc = failFor('firestore', 'getDoc');
const failCollection = failFor('firestore', 'getDocs');
const failBatch = failFor('firestore', 'writeBatch');

describe('the renames', () => {
  it('maps neighbouring spellings onto the record shape', () => {
    expect(RENAMES.collection).toBe('path');
    expect(RENAMES.collectionPath).toBe('path');
    expect(RENAMES.documentPath).toBe('path');
    expect(RENAMES.docPath).toBe('path');
    expect(RENAMES.ref).toBe('path');
    expect(RENAMES.reference).toBe('path');
    expect(RENAMES.doc).toBe('path');
    expect(RENAMES.fields).toBe('data');
    expect(RENAMES.filters).toBe('constraints');
    expect(RENAMES.where).toBe('constraints');
    expect(RENAMES.merge).toBe('options');
  });
});

describe('checkDocumentPath', () => {
  it('rejects an empty path', () => {
    const rejection = checkDocumentPath('getDoc', { path: '' }, failDoc);
    expect(rejection).not.toBeNull();
    expect(rejection?.summary).toContain('empty path');
  });

  it('rejects a collection path (odd segments)', () => {
    const rejection = checkDocumentPath('getDoc', { path: 'users' }, failDoc);
    expect(rejection).not.toBeNull();
    expect(rejection?.summary).toContain('not a document path');
    expect(rejection?.data.fix).toContain('users/<documentId>');
  });

  it('passes a document path (even segments)', () => {
    expect(checkDocumentPath('getDoc', { path: 'users/alice' }, failDoc)).toBeNull();
  });
});

describe('checkCollectionPath', () => {
  it('rejects an empty path', () => {
    const rejection = checkCollectionPath('getDocs', { path: '' }, failCollection);
    expect(rejection).not.toBeNull();
    expect(rejection?.summary).toContain('empty path');
  });

  it('rejects a document path (even segments)', () => {
    const rejection = checkCollectionPath('getDocs', { path: 'users/alice' }, failCollection);
    expect(rejection).not.toBeNull();
    expect(rejection?.summary).toContain('not a collection path');
    expect(rejection?.data.fix).toContain('users');
  });

  it('passes a collection path (odd segments)', () => {
    expect(checkCollectionPath('getDocs', { path: 'users' }, failCollection)).toBeNull();
  });
});

describe('constraintsOf', () => {
  it('reads an array constraints argument', () => {
    const entries = [{ type: 'limit', value: 1 }];
    expect(constraintsOf({ constraints: entries })).toBe(entries);
  });

  it('is empty when constraints is absent or not an array', () => {
    expect(constraintsOf({})).toEqual([]);
    expect(constraintsOf({ constraints: 'nope' })).toEqual([]);
  });
});

describe('checkConstraints', () => {
  it('checks the collection path before any constraint', () => {
    const rejection = checkConstraints({ path: 'users/alice', constraints: [] }, failCollection);
    expect(rejection?.summary).toContain('not a collection path');
  });

  it('rejects a constraint whose type is not where, orderBy, or limit', () => {
    const rejection = checkConstraints(
      { path: 'users', constraints: [{ type: 'skip' }] },
      failCollection,
    );
    expect(rejection?.data.field).toBe('constraints.0.type');
  });

  it('rejects a where with no field', () => {
    const rejection = checkConstraints(
      { path: 'users', constraints: [{ type: 'where', op: '==', value: 1 }] },
      failCollection,
    );
    expect(rejection?.data.field).toBe('constraints.0.field');
  });

  it('rejects a where with an operator the SDK does not have', () => {
    const rejection = checkConstraints(
      { path: 'users', constraints: [{ type: 'where', field: 'role', op: 'has' }] },
      failCollection,
    );
    expect(rejection?.data.field).toBe('constraints.0.op');
  });

  it('rejects an orderBy with no field', () => {
    const rejection = checkConstraints(
      { path: 'users', constraints: [{ type: 'orderBy' }] },
      failCollection,
    );
    expect(rejection?.data.field).toBe('constraints.0.field');
  });

  it('rejects a limit whose value is not a number', () => {
    const rejection = checkConstraints(
      { path: 'users', constraints: [{ type: 'limit', value: '3' }] },
      failCollection,
    );
    expect(rejection?.data.field).toBe('constraints.0.value');
  });

  it('rejects an inequality filter whose first orderBy field differs', () => {
    const rejection = checkConstraints(
      {
        path: 'users',
        constraints: [
          { type: 'where', field: 'age', op: '>', value: 18 },
          { type: 'orderBy', field: 'name' },
        ],
      },
      failCollection,
    );
    expect(rejection?.data.field).toBe('constraints');
    expect(rejection?.summary).toContain('first orderBy field to match');
  });

  it('passes an inequality filter ordered on the same field', () => {
    const rejection = checkConstraints(
      {
        path: 'users',
        constraints: [
          { type: 'where', field: 'age', op: '>', value: 18 },
          { type: 'orderBy', field: 'age' },
        ],
      },
      failCollection,
    );
    expect(rejection).toBeNull();
  });

  it('passes a well-formed collection read with no constraints', () => {
    expect(checkConstraints({ path: 'users', constraints: [] }, failCollection)).toBeNull();
  });
});

describe('collectionRead', () => {
  it('builds a where, orderBy, and limit call from the constraint list', () => {
    const built = collectionRead({
      path: 'users',
      constraints: [
        { type: 'where', field: 'age', op: '>', value: 18 },
        { type: 'orderBy', field: 'age', direction: 'desc' },
        { type: 'limit', value: 5 },
      ],
    });
    expect(built.call).toEqual({
      collection: 'users',
      orderBy: 'age',
      limit: 5,
      where: [{ field: 'age', op: '>', value: 18 }],
    });
    expect(built.filtered).toBe(true);
    expect(built.direction).toBe('desc');
  });

  it('omits where, orderBy, and limit when no constraint supplies them', () => {
    const built = collectionRead({ path: 'users', constraints: [] });
    expect(built.call).toEqual({ collection: 'users' });
    expect(built.filtered).toBe(false);
    expect(built.direction).toBeUndefined();
  });
});

describe('checkBatch', () => {
  it('rejects a write whose path is not a document path', () => {
    const rejection = checkBatch(
      { writes: [{ type: 'delete', path: 'users' }] },
      failBatch,
    );
    expect(rejection?.data.field).toBe('writes.0.path');
  });

  it('rejects a set or update with no data', () => {
    const rejection = checkBatch(
      { writes: [{ type: 'set', path: 'users/alice' }] },
      failBatch,
    );
    expect(rejection?.data.field).toBe('writes.0.data');
  });

  it('does not require data on a delete', () => {
    expect(checkBatch({ writes: [{ type: 'delete', path: 'users/alice' }] }, failBatch)).toBeNull();
  });

  it('passes a well-formed batch', () => {
    const batch = {
      writes: [
        { type: 'set', path: 'users/alice', data: { role: 'admin' } },
        { type: 'delete', path: 'users/bob' },
      ],
    };
    expect(checkBatch(batch, failBatch)).toBeNull();
  });
});
