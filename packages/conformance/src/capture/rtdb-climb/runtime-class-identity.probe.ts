import {
  DataSnapshot,
  Database,
  QueryConstraint,
  TransactionResult,
  endAt,
  endBefore,
  equalTo,
  get,
  limitToFirst,
  limitToLast,
  orderByChild,
  orderByKey,
  orderByPriority,
  orderByValue,
  ref,
  runTransaction,
  set,
  startAfter,
  startAt,
} from 'firebase/database';
import {
  adminRemove,
  cleanup,
  createClient,
  directConstruction,
  prototypeShape,
  repeatStable,
  scenarioPath,
} from './probe-runtime.ts';
import type { RtdbClimbContext, RtdbClimbProbe } from './probe-types.ts';

export function createProbe(ctx: RtdbClimbContext): RtdbClimbProbe {
  return {
      name: 'rtdb-modular-runtime-class-identity',
      matrixRow: 'rtdb-modular#M85, rtdb-modular#M86, rtdb-modular#M87, rtdb-modular#M88',
      rowIds: ['rtdb-modular#M85', 'rtdb-modular#M86', 'rtdb-modular#M87', 'rtdb-modular#M88'],
      description:
        'Runtime constructor exports, actual-instance prototype identity, direct construction, and TransactionResult.toJSON behavior.',
      observe: () => repeatStable(2, async (attempt) => {
        const path = scenarioPath(ctx, 'runtime-class-identity', attempt);
        const client = await createClient(ctx, `runtime-class-identity-${attempt}`);
        try {
          await set(ref(client.db, path), { value: 1 });
          const snapshot = await get(ref(client.db, path));
          const constraintFactories = {
            orderByChild: orderByChild('value'),
            orderByKey: orderByKey(),
            orderByPriority: orderByPriority(),
            orderByValue: orderByValue(),
            startAt: startAt(1),
            startAfter: startAfter(1),
            endAt: endAt(1),
            endBefore: endBefore(1),
            equalTo: equalTo(1),
            limitToFirst: limitToFirst(1),
            limitToLast: limitToLast(1),
          };
          const constraint = constraintFactories.orderByKey;
          const result = await runTransaction(ref(client.db, `${path}/counter`), (value) =>
            ((value as number | null) ?? 0) + 1);
          return {
            exportTypes: {
              Database: typeof Database,
              DataSnapshot: typeof DataSnapshot,
              QueryConstraint: typeof QueryConstraint,
              TransactionResult: typeof TransactionResult,
            },
            database: prototypeShape(client.db, Database),
            snapshot: prototypeShape(snapshot, DataSnapshot),
            queryConstraint: prototypeShape(constraint, QueryConstraint),
            constraintFactories: Object.fromEntries(
              Object.entries(constraintFactories).map(([name, value]) => [
                name,
                prototypeShape(value, QueryConstraint),
              ]),
            ),
            transactionResult: {
              ...prototypeShape(result, TransactionResult),
              toJSONType: typeof result.toJSON,
              toJSON: result.toJSON(),
            },
            directConstruction: {
              Database: directConstruction(Database as unknown as new () => object),
              DataSnapshot: directConstruction(DataSnapshot as unknown as new () => object),
              QueryConstraint: directConstruction(QueryConstraint as unknown as new () => object),
              TransactionResult: directConstruction(TransactionResult as unknown as new () => object),
            },
          };
        } finally {
          await cleanup([() => client.close(), () => adminRemove(ctx, path)]);
        }
      }),
    };
}
