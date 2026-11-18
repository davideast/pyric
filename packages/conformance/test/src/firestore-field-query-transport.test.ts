import { describe, expect, it } from 'bun:test';
import { observeFirestoreFieldQuery } from '../../src/firestore-not-in-probe.ts';
import { FirestoreQueryTimeoutError } from '../../src/firestore-probe-outcomes.ts';
import { runFirestoreRestFieldQuery } from '../../src/firestore-rest-run-query.ts';

describe('Firestore field-query Node -> REST fallback across null and disjunctive operators', () => {
  it('encodes IS_NULL, IS_NOT_NULL, IN, and scalar operators identically to @firebase/firestore/lite on REST fallback', async () => {
    const recordedBodies: Array<Record<string, unknown>> = [];
    const mockFetch = async (_url: string, init: { body: string }) => {
      recordedBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(
        JSON.stringify([
          {
            document: {
              name: 'projects/demo-proj/databases/(default)/documents/pyric_oracle/fs_t1_aa/where-existence-null/null_val',
            },
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const eqNull = await observeFirestoreFieldQuery({
      webConfig: { projectId: 'demo-proj', apiKey: 'demo-key' },
      collectionPath: 'pyric_oracle/fs_t1_aa/where-existence-null',
      field: 'val',
      op: '==',
      value: null,
      runNodeQuery: async () => {
        throw new FirestoreQueryTimeoutError(40, 'node timeout');
      },
      runRestQuery: async (params) =>
        runFirestoreRestFieldQuery({
          projectId: 'demo-proj',
          accessToken: 'tok-123',
          collectionPath: params.collectionPath,
          field: params.field,
          op: params.op,
          value: params.value,
          fetchImpl: mockFetch,
        }),
    });
    expect(eqNull).toEqual({
      threw: false,
      ids: ['null_val'],
      code: null,
      errorName: null,
      transport: 'firestore-rest-runQuery',
    });

    await runFirestoreRestFieldQuery({
      projectId: 'demo-proj',
      accessToken: 'tok-123',
      collectionPath: 'pyric_oracle/fs_t1_aa/where-existence-null',
      field: 'val',
      op: '!=',
      value: null,
      fetchImpl: mockFetch,
    });

    await runFirestoreRestFieldQuery({
      projectId: 'demo-proj',
      accessToken: 'tok-123',
      collectionPath: 'pyric_oracle/fs_t1_aa/where-existence-null',
      field: 'val',
      op: 'in',
      value: [10, null],
      fetchImpl: mockFetch,
    });

    await runFirestoreRestFieldQuery({
      projectId: 'demo-proj',
      accessToken: 'tok-123',
      collectionPath: 'pyric_oracle/fs_t1_aa/where-existence-null',
      field: 'val',
      op: '<',
      value: 20,
      fetchImpl: mockFetch,
    });

    expect(recordedBodies[0]).toEqual({
      structuredQuery: {
        from: [{ collectionId: 'where-existence-null' }],
        where: {
          unaryFilter: {
            field: { fieldPath: 'val' },
            op: 'IS_NULL',
          },
        },
        orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      },
    });
    expect(recordedBodies[1]).toEqual({
      structuredQuery: {
        from: [{ collectionId: 'where-existence-null' }],
        where: {
          unaryFilter: {
            field: { fieldPath: 'val' },
            op: 'IS_NOT_NULL',
          },
        },
        orderBy: [
          { field: { fieldPath: 'val' }, direction: 'ASCENDING' },
          { field: { fieldPath: '__name__' }, direction: 'ASCENDING' },
        ],
      },
    });
    expect(recordedBodies[2]).toEqual({
      structuredQuery: {
        from: [{ collectionId: 'where-existence-null' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'val' },
            op: 'IN',
            value: {
              arrayValue: {
                values: [{ integerValue: '10' }, { nullValue: 'NULL_VALUE' }],
              },
            },
          },
        },
        orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      },
    });
    expect(recordedBodies[3]).toEqual({
      structuredQuery: {
        from: [{ collectionId: 'where-existence-null' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'val' },
            op: 'LESS_THAN',
            value: { integerValue: '20' },
          },
        },
        orderBy: [
          { field: { fieldPath: 'val' }, direction: 'ASCENDING' },
          { field: { fieldPath: '__name__' }, direction: 'ASCENDING' },
        ],
      },
    });
  });
});
