import { describe, expect, test } from 'bun:test';
import { LocalEnvironment } from '../../../../src/firestore/sandbox/local-environment.js';
import { createDocumentRef } from '../../../../src/firestore/sandbox/admin-compat/collection-ref.js';
import { QueryImpl } from '../../../../src/firestore/sandbox/admin-compat/query.js';
import type { Filter } from '../../../../src/firestore/sandbox/admin-compat/types.js';

function makeQuery(): QueryImpl {
  const env = new LocalEnvironment();
  return new QueryImpl({
    env,
    auth: null,
    collectionPath: 'posts',
    documentRef: (path) => createDocumentRef(env, null, path, false),
  });
}

describe('QueryImpl', () => {
  test('snapshots caller-owned filter structure into one executable plan', () => {
    const leaf: Filter = {
      kind: 'where', field: 'visibility', op: '==', value: 'public',
    };
    const callerFilter: Filter = { kind: 'and', filters: [leaf] };
    const query = makeQuery().applyFilter(callerFilter) as QueryImpl;
    const plan = query.snapshotConstraints();

    leaf.value = 'private';
    (callerFilter.filters as Filter[]).length = 0;

    expect(plan.execution.filters).toEqual([{
      kind: 'and',
      filters: [{ kind: 'where', field: 'visibility', op: '==', value: 'public' }],
    }]);
    expect('structured' in plan).toBe(false);
  });

  test('does not expose mutable proof or execution leaves', () => {
    const query = makeQuery().where('visibility', '==', 'private') as QueryImpl;
    const plan = query.snapshotConstraints();
    const leaf = plan.execution.filters[0] as {
      kind: 'where'; field: string; op: string; value: unknown;
    };

    expect(() => { leaf.value = 'public'; }).toThrow(TypeError);
    expect(leaf.value).toBe('private');
  });
});
