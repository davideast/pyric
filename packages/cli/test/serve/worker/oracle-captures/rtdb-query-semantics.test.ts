import { describe, expect, it } from 'bun:test';
import {
  observeOrderByKeyNameCompare,
  type OrderByKeyProbeSdk,
} from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-orderbykey-namecompare.ts';
import {
  observeQueryChainingAndForEachOrder,
  type QueryChainingAndForEachProbeSdk,
} from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-query-chaining-and-foreach-order.ts';
import {
  observeQueryConstraintConflicts,
  type ConstraintConflictProbeSdk,
} from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-query-constraint-conflicts.ts';
import {
  observeQueryEmptyAndOversizedWindow,
  type EmptyAndOversizedWindowProbeSdk,
} from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-query-empty-and-oversized-window.ts';
import {
  observeQueryPrimitiveLeafAndObjectTies,
  type PrimitiveLeafAndObjectTiesProbeSdk,
} from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-query-primitive-leaf-and-object-ties.ts';
import {
  observeStartAtKeyTieBreakerAndMissingChild,
  type TieBreakerAndMissingChildProbeSdk,
} from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-startat-key-tiebreaker-and-missing-child.ts';
import type { RtdbScenarioContext } from '../../../../../conformance/src/capture/sdk-scenarios/scenario-types.ts';
import { hostedRtdbContext, load, restoreSharedWorker, servedRtdbContext } from './support.ts';

restoreSharedWorker();

const QUERY_CAPTURE_RULES: Record<string, unknown> = {
  rules: {
    pyric_oracle: {
      replay: {
        '.read': true,
        '.write': true,
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
};

type ServedPlaneFactory = () => Promise<RtdbScenarioContext>;

const PLANES: ReadonlyArray<[string, ServedPlaneFactory]> = [
  ['served SharedWorker', () => servedRtdbContext(QUERY_CAPTURE_RULES)],
  ['served Node host', () => hostedRtdbContext(QUERY_CAPTURE_RULES)],
];

for (const [planeLabel, createContext] of PLANES) {
  describe(`RTDB modular query semantics oracle captures (${planeLabel})`, () => {
    it('rtdb-modular-orderbykey-namecompare (rtdb-modular#M50)', async () => {
      const ctx = await createContext();
      const actual = await observeOrderByKeyNameCompare(
        {
          ...(ctx.rtdb as unknown as Omit<OrderByKeyProbeSdk, 'db'>),
          db: ctx.db as unknown as OrderByKeyProbeSdk['db'],
        },
        ctx.base,
      );
      expect(actual as unknown).toEqual(load('rtdb-modular-orderbykey-namecompare'));
    });

    it('rtdb-modular-query-empty-and-oversized-window (rtdb-modular#M53, #M56, #M59)', async () => {
      const ctx = await createContext();
      const actual = await observeQueryEmptyAndOversizedWindow(
        {
          ...(ctx.rtdb as unknown as Omit<EmptyAndOversizedWindowProbeSdk, 'db'>),
          db: ctx.db as unknown as EmptyAndOversizedWindowProbeSdk['db'],
        },
        ctx.base,
      );
      expect(actual as unknown).toEqual(load('rtdb-modular-query-empty-and-oversized-window'));
    });

    it('rtdb-modular-query-chaining-and-foreach-order (rtdb-modular#M36, #M60, #M61)', async () => {
      const ctx = await createContext();
      const actual = await observeQueryChainingAndForEachOrder(
        {
          ...(ctx.rtdb as unknown as Omit<QueryChainingAndForEachProbeSdk, 'db'>),
          db: ctx.db as unknown as QueryChainingAndForEachProbeSdk['db'],
        },
        ctx.base,
      );
      expect(actual.forEachOrderVsValNonIntegerKeys.get.forEachKeys).toEqual(['z', 'a', 'm']);
      expect(actual.forEachOrderVsValNonIntegerKeys.get.valObjectKeys).toEqual(['a', 'm', 'z']);
      expect(actual as unknown).toEqual(load('rtdb-modular-query-chaining-and-foreach-order'));
    });

    it('rtdb-modular-startat-key-tiebreaker-and-missing-child (rtdb-modular#M62, #M63)', async () => {
      const ctx = await createContext();
      const actual = await observeStartAtKeyTieBreakerAndMissingChild(
        {
          ...(ctx.rtdb as unknown as Omit<TieBreakerAndMissingChildProbeSdk, 'db'>),
          db: ctx.db as unknown as TieBreakerAndMissingChildProbeSdk['db'],
        },
        ctx.base,
      );
      expect(actual as unknown).toEqual(
        load('rtdb-modular-startat-key-tiebreaker-and-missing-child'),
      );
    });

    it('rtdb-modular-query-primitive-leaf-and-object-ties (rtdb-modular#M64, #M72)', async () => {
      const ctx = await createContext();
      const actual = await observeQueryPrimitiveLeafAndObjectTies(
        {
          ...(ctx.rtdb as unknown as Omit<PrimitiveLeafAndObjectTiesProbeSdk, 'db'>),
          db: ctx.db as unknown as PrimitiveLeafAndObjectTiesProbeSdk['db'],
        },
        ctx.base,
      );
      expect(actual as unknown).toEqual(load('rtdb-modular-query-primitive-leaf-and-object-ties'));
    });

    it('rtdb-modular-query-constraint-conflicts (rtdb-modular#M69)', async () => {
      const ctx = await createContext();
      const baseRef = ctx.rtdb.ref(ctx.db, `${ctx.base}/items`) as unknown as Parameters<
        typeof observeQueryConstraintConflicts
      >[1];
      const actual = observeQueryConstraintConflicts(
        ctx.rtdb as unknown as ConstraintConflictProbeSdk,
        baseRef,
      );
      expect(actual as unknown).toEqual(load('rtdb-modular-query-constraint-conflicts'));
    });
  });
}
