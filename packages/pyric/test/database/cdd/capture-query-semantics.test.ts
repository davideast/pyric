import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import * as pyricRtdb from 'pyric/database';
import {
  observeOrderByKeyNameCompare,
  type OrderByKeyProbeSdk,
} from '../../../../conformance/probes/rtdb-modular/rtdb-modular-orderbykey-namecompare.ts';
import {
  observeQueryChainingAndForEachOrder,
  type QueryChainingAndForEachProbeSdk,
} from '../../../../conformance/probes/rtdb-modular/rtdb-modular-query-chaining-and-foreach-order.ts';
import {
  observeQueryConstraintConflicts,
  type ConstraintConflictProbeSdk,
} from '../../../../conformance/probes/rtdb-modular/rtdb-modular-query-constraint-conflicts.ts';
import {
  observeQueryEmptyAndOversizedWindow,
  type EmptyAndOversizedWindowProbeSdk,
} from '../../../../conformance/probes/rtdb-modular/rtdb-modular-query-empty-and-oversized-window.ts';
import {
  observeQueryPrimitiveLeafAndObjectTies,
  type PrimitiveLeafAndObjectTiesProbeSdk,
} from '../../../../conformance/probes/rtdb-modular/rtdb-modular-query-primitive-leaf-and-object-ties.ts';
import {
  observeStartAtKeyTieBreakerAndMissingChild,
  type TieBreakerAndMissingChildProbeSdk,
} from '../../../../conformance/probes/rtdb-modular/rtdb-modular-startat-key-tiebreaker-and-missing-child.ts';
import { obs } from './capture-replay.ts';

function withQuerySandbox<T>(
  run: (db: OrderByKeyProbeSdk['db'], sdk: typeof pyricRtdb) => Promise<T> | T,
): Promise<T> {
  const sandbox = initializeSandbox({ projectId: 'demo-rtdb-query-cdd' });
  const rawDb = pyricRtdb.getDatabase(sandbox.withAuth({ uid: 'reader-1' }));
  pyricRtdb.sandbox.setRules(rawDb, {
    rules: {
      pyric_oracle: {
        replay: {
          '.read': 'auth != null',
          '.write': 'auth != null',
          items: { '.indexOn': ['group', 'pos'] },
          absent: { '.indexOn': ['pos'] },
          chained: { '.indexOn': ['rank'] },
          nonIntKeys: { '.indexOn': ['rank'] },
          intKeys: { '.indexOn': ['rank'] },
          ties: { '.indexOn': ['pos'] },
          missingField: { '.indexOn': ['pos', 'meta/score'] },
          leafNum: { '.indexOn': '.value' },
          objTies: { '.indexOn': '.value' },
        },
      },
    },
  });
  return Promise.resolve()
    .then(() => run(rawDb as unknown as OrderByKeyProbeSdk['db'], pyricRtdb))
    .finally(() => {
      sandbox.dispose();
    });
}

describe('RTDB modular query semantics oracle captures (in-page sandbox)', () => {
  it('rtdb-modular-orderbykey-namecompare (rtdb-modular#M50)', async () => {
    const actual = await withQuerySandbox((db, sdk) =>
      observeOrderByKeyNameCompare(
        {
          db,
          ref: sdk.ref as unknown as OrderByKeyProbeSdk['ref'],
          set: sdk.set as unknown as OrderByKeyProbeSdk['set'],
          get: sdk.get as unknown as OrderByKeyProbeSdk['get'],
          onValue: sdk.onValue as unknown as OrderByKeyProbeSdk['onValue'],
          query: sdk.query as unknown as OrderByKeyProbeSdk['query'],
          orderByKey: sdk.orderByKey as unknown as OrderByKeyProbeSdk['orderByKey'],
          startAt: sdk.startAt as unknown as OrderByKeyProbeSdk['startAt'],
          endAt: sdk.endAt as unknown as OrderByKeyProbeSdk['endAt'],
        },
        '/pyric_oracle/replay',
      ),
    );
    expect(actual as unknown).toEqual(obs('rtdb-modular-orderbykey-namecompare'));
  });

  it('rtdb-modular-query-empty-and-oversized-window (rtdb-modular#M53, #M56, #M59)', async () => {
    const actual = await withQuerySandbox((db, sdk) =>
      observeQueryEmptyAndOversizedWindow(
        {
          db,
          ref: sdk.ref as unknown as EmptyAndOversizedWindowProbeSdk['ref'],
          set: sdk.set as unknown as EmptyAndOversizedWindowProbeSdk['set'],
          get: sdk.get as unknown as EmptyAndOversizedWindowProbeSdk['get'],
          onValue: sdk.onValue as unknown as EmptyAndOversizedWindowProbeSdk['onValue'],
          query: sdk.query as unknown as EmptyAndOversizedWindowProbeSdk['query'],
          orderByChild: sdk.orderByChild as unknown as EmptyAndOversizedWindowProbeSdk['orderByChild'],
          orderByKey: sdk.orderByKey as unknown as EmptyAndOversizedWindowProbeSdk['orderByKey'],
          equalTo: sdk.equalTo as unknown as EmptyAndOversizedWindowProbeSdk['equalTo'],
          limitToFirst: sdk.limitToFirst as unknown as EmptyAndOversizedWindowProbeSdk['limitToFirst'],
          limitToLast: sdk.limitToLast as unknown as EmptyAndOversizedWindowProbeSdk['limitToLast'],
        },
        '/pyric_oracle/replay',
      ),
    );
    expect(actual as unknown).toEqual(obs('rtdb-modular-query-empty-and-oversized-window'));
  });

  it('rtdb-modular-query-chaining-and-foreach-order (rtdb-modular#M36, #M60, #M61)', async () => {
    const actual = await withQuerySandbox((db, sdk) =>
      observeQueryChainingAndForEachOrder(
        {
          db,
          ref: sdk.ref as unknown as QueryChainingAndForEachProbeSdk['ref'],
          set: sdk.set as unknown as QueryChainingAndForEachProbeSdk['set'],
          get: sdk.get as unknown as QueryChainingAndForEachProbeSdk['get'],
          onValue: sdk.onValue as unknown as QueryChainingAndForEachProbeSdk['onValue'],
          query: sdk.query as unknown as QueryChainingAndForEachProbeSdk['query'],
          orderByChild: sdk.orderByChild as unknown as QueryChainingAndForEachProbeSdk['orderByChild'],
          startAt: sdk.startAt as unknown as QueryChainingAndForEachProbeSdk['startAt'],
          endAt: sdk.endAt as unknown as QueryChainingAndForEachProbeSdk['endAt'],
          limitToFirst: sdk.limitToFirst as unknown as QueryChainingAndForEachProbeSdk['limitToFirst'],
        },
        '/pyric_oracle/replay',
      ),
    );
    expect(actual.forEachOrderVsValNonIntegerKeys.get.forEachKeys).toEqual(['z', 'a', 'm']);
    expect(actual.forEachOrderVsValNonIntegerKeys.get.valObjectKeys).toEqual(['a', 'm', 'z']);
    expect(actual as unknown).toEqual(obs('rtdb-modular-query-chaining-and-foreach-order'));
  });

  it('rtdb-modular-startat-key-tiebreaker-and-missing-child (rtdb-modular#M62, #M63)', async () => {
    const actual = await withQuerySandbox((db, sdk) =>
      observeStartAtKeyTieBreakerAndMissingChild(
        {
          db,
          ref: sdk.ref as unknown as TieBreakerAndMissingChildProbeSdk['ref'],
          set: sdk.set as unknown as TieBreakerAndMissingChildProbeSdk['set'],
          get: sdk.get as unknown as TieBreakerAndMissingChildProbeSdk['get'],
          query: sdk.query as unknown as TieBreakerAndMissingChildProbeSdk['query'],
          orderByChild: sdk.orderByChild as unknown as TieBreakerAndMissingChildProbeSdk['orderByChild'],
          startAt: sdk.startAt as unknown as TieBreakerAndMissingChildProbeSdk['startAt'],
          endAt: sdk.endAt as unknown as TieBreakerAndMissingChildProbeSdk['endAt'],
        },
        '/pyric_oracle/replay',
      ),
    );
    expect(actual as unknown).toEqual(obs('rtdb-modular-startat-key-tiebreaker-and-missing-child'));
  });

  it('rtdb-modular-query-primitive-leaf-and-object-ties (rtdb-modular#M64, #M72)', async () => {
    const actual = await withQuerySandbox((db, sdk) =>
      observeQueryPrimitiveLeafAndObjectTies(
        {
          db,
          ref: sdk.ref as unknown as PrimitiveLeafAndObjectTiesProbeSdk['ref'],
          set: sdk.set as unknown as PrimitiveLeafAndObjectTiesProbeSdk['set'],
          get: sdk.get as unknown as PrimitiveLeafAndObjectTiesProbeSdk['get'],
          onValue: sdk.onValue as unknown as PrimitiveLeafAndObjectTiesProbeSdk['onValue'],
          query: sdk.query as unknown as PrimitiveLeafAndObjectTiesProbeSdk['query'],
          orderByKey: sdk.orderByKey as unknown as PrimitiveLeafAndObjectTiesProbeSdk['orderByKey'],
          orderByValue: sdk.orderByValue as unknown as PrimitiveLeafAndObjectTiesProbeSdk['orderByValue'],
          startAt: sdk.startAt as unknown as PrimitiveLeafAndObjectTiesProbeSdk['startAt'],
          limitToFirst: sdk.limitToFirst as unknown as PrimitiveLeafAndObjectTiesProbeSdk['limitToFirst'],
        },
        '/pyric_oracle/replay',
      ),
    );
    expect(actual as unknown).toEqual(obs('rtdb-modular-query-primitive-leaf-and-object-ties'));
  });

  it('rtdb-modular-query-constraint-conflicts (rtdb-modular#M69)', async () => {
    const actual = await withQuerySandbox((db, sdk) => {
      const adapter: ConstraintConflictProbeSdk = {
        query: sdk.query as unknown as ConstraintConflictProbeSdk['query'],
        orderByChild: sdk.orderByChild as unknown as ConstraintConflictProbeSdk['orderByChild'],
        orderByKey: sdk.orderByKey as unknown as ConstraintConflictProbeSdk['orderByKey'],
        orderByValue: sdk.orderByValue as unknown as ConstraintConflictProbeSdk['orderByValue'],
        orderByPriority: sdk.orderByPriority as unknown as ConstraintConflictProbeSdk['orderByPriority'],
        startAt: sdk.startAt as unknown as ConstraintConflictProbeSdk['startAt'],
        startAfter: sdk.startAfter as unknown as ConstraintConflictProbeSdk['startAfter'],
        endAt: sdk.endAt as unknown as ConstraintConflictProbeSdk['endAt'],
        endBefore: sdk.endBefore as unknown as ConstraintConflictProbeSdk['endBefore'],
        equalTo: sdk.equalTo as unknown as ConstraintConflictProbeSdk['equalTo'],
        limitToFirst: sdk.limitToFirst as unknown as ConstraintConflictProbeSdk['limitToFirst'],
        limitToLast: sdk.limitToLast as unknown as ConstraintConflictProbeSdk['limitToLast'],
      };
      const baseRef = sdk.ref(
        db as unknown as Parameters<typeof sdk.ref>[0],
        'pyric_oracle/replay/items',
      ) as unknown as Parameters<typeof observeQueryConstraintConflicts>[1];
      return observeQueryConstraintConflicts(adapter, baseRef);
    });
    expect(actual as unknown).toEqual(obs('rtdb-modular-query-constraint-conflicts'));
  });
});
