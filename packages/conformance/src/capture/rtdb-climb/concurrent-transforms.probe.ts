import {
  get,
  increment,
  ref,
  runTransaction,
  set,
  update,
} from 'firebase/database';
import {
  adminRead,
  adminRemove,
  cleanup,
  createClient,
  repeatStable,
  scenarioPath,
} from './probe-runtime.ts';
import type { RtdbClimbContext, RtdbClimbProbe } from './probe-types.ts';

export function createProbe(ctx: RtdbClimbContext): RtdbClimbProbe {
  return {
      name: 'rtdb-modular-concurrent-transforms',
      matrixRow: 'rtdb-modular#M37h, rtdb-modular#157, rtdb-modular#161',
      rowIds: ['rtdb-modular#M37h', 'rtdb-modular#157', 'rtdb-modular#161'],
      description:
        'Two-client concurrent increments and transactions preserve both updates, with transaction retry evidence and independent terminal reads.',
      observe: () => repeatStable(2, async (attempt) => {
        const path = scenarioPath(ctx, 'concurrent-transforms', attempt);
        const first = await createClient(ctx, `concurrent-transforms-${attempt}-first`);
        const second = await createClient(ctx, `concurrent-transforms-${attempt}-second`);
        try {
          const incrementPath = `${path}/increment`;
          await set(ref(first.db, incrementPath), 0);
          await Promise.all([
            update(ref(first.db, path), { increment: increment(2) }),
            update(ref(second.db, path), { increment: increment(3) }),
          ]);
          const transactionPath = `${path}/transaction`;
          await set(ref(first.db, transactionPath), 0);
          await Promise.all([get(ref(first.db, transactionPath)), get(ref(second.db, transactionPath))]);
          const firstArgs: unknown[] = [];
          const secondArgs: unknown[] = [];
          const results = await Promise.all([
            runTransaction(ref(first.db, transactionPath), (current) => {
              firstArgs.push(current);
              return ((current as number | null) ?? 0) + 1;
            }),
            runTransaction(ref(second.db, transactionPath), (current) => {
              secondArgs.push(current);
              return ((current as number | null) ?? 0) + 1;
            }),
          ]);
          return {
            incrementTerminal: await adminRead(ctx, incrementPath),
            transactionTerminal: await adminRead(ctx, transactionPath),
            committed: results.map((result) => result.committed),
            retryObserved: firstArgs.length > 1 || secondArgs.length > 1,
            invocationCountsSorted: [firstArgs.length, secondArgs.length].sort((a, b) => a - b),
            finalSnapshotsSorted: results.map((result) => result.snapshot.val()).sort(),
          };
        } finally {
          await cleanup([() => first.close(), () => second.close(), () => adminRemove(ctx, path)]);
        }
      }),
    };
}
