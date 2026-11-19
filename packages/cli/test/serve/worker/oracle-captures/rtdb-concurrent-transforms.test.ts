import { describe, expect, it } from 'bun:test';
import {
  hostedRtdbContext,
  load,
  restoreSharedWorker,
  servedRtdbContext,
  type ServedRtdbAdminContext,
} from './support.ts';

restoreSharedWorker();

interface ConcurrentTransformsObservation {
  incrementTerminal: number;
  transactionTerminal: number;
  committed: boolean[];
  retryObserved: boolean;
  invocationCountsSorted: number[];
  finalSnapshotsSorted: number[];
}

const PLANES: ReadonlyArray<[string, () => Promise<ServedRtdbAdminContext>]> = [
  ['served SharedWorker', () => servedRtdbContext()],
  ['served Node host', () => hostedRtdbContext()],
];

for (const [planeName, createContext] of PLANES) {
  describe(`rtdb-modular-concurrent-transforms (${planeName})`, () => {
    it('preserves concurrent two-client increments and retries contending transactions across the wire (M37h, 157, 161)', async () => {
      const obs = load('rtdb-modular-concurrent-transforms') as unknown as ConcurrentTransformsObservation;
      const ctx = await createContext();
      const first = await ctx.newClient('concurrent-first');
      const second = await ctx.newClient('concurrent-second');
      const adminDb = await ctx.openAdminDb();
      const basePath = `${ctx.base}/concurrent-transforms`;

      const incrementPath = `${basePath}/increment`;
      await ctx.rtdb.set(ctx.rtdb.ref(first.db, incrementPath), 0);
      await Promise.all([
        ctx.rtdb.update(ctx.rtdb.ref(first.db, basePath), {
          increment: ctx.rtdb.increment(2),
        }),
        ctx.rtdb.update(ctx.rtdb.ref(second.db, basePath), {
          increment: ctx.rtdb.increment(3),
        }),
      ]);
      const incrementAdminSnap = await adminDb.ref(incrementPath).get();
      expect(incrementAdminSnap.val()).toBe(obs.incrementTerminal);

      const directSetIncrementPath = `${basePath}/increment-set`;
      await ctx.rtdb.set(ctx.rtdb.ref(first.db, directSetIncrementPath), 0);
      await Promise.all([
        ctx.rtdb.set(
          ctx.rtdb.ref(first.db, directSetIncrementPath),
          ctx.rtdb.increment(2),
        ),
        ctx.rtdb.set(
          ctx.rtdb.ref(second.db, directSetIncrementPath),
          ctx.rtdb.increment(3),
        ),
      ]);
      const setIncrementAdminSnap = await adminDb.ref(directSetIncrementPath).get();
      expect(setIncrementAdminSnap.val()).toBe(obs.incrementTerminal);

      const transactionPath = `${basePath}/transaction`;
      await ctx.rtdb.set(ctx.rtdb.ref(first.db, transactionPath), 0);
      await Promise.all([
        ctx.rtdb.get(ctx.rtdb.ref(first.db, transactionPath)),
        ctx.rtdb.get(ctx.rtdb.ref(second.db, transactionPath)),
      ]);

      const firstArgs: unknown[] = [];
      const secondArgs: unknown[] = [];
      const results = await Promise.all([
        ctx.rtdb.runTransaction(ctx.rtdb.ref(first.db, transactionPath), (current) => {
          firstArgs.push(current);
          const base = (current as number | null) ?? 0;
          return base + 1;
        }),
        ctx.rtdb.runTransaction(ctx.rtdb.ref(second.db, transactionPath), (current) => {
          secondArgs.push(current);
          const base = (current as number | null) ?? 0;
          return base + 1;
        }),
      ]);

      const warmCountsSorted = [firstArgs.length, secondArgs.length].sort((a, b) => a - b);
      // Production cold clients run one initial speculative-null pass per client
      // (`rtdb-modular#160` by-design + `rtdb-modular#M37b`), shifting [1, 2] -> [2, 3].
      expect(obs.invocationCountsSorted).toEqual([2, 3]);
      expect(warmCountsSorted).toEqual([1, 2]);
      expect(firstArgs.length > 1 || secondArgs.length > 1).toBe(obs.retryObserved);
      expect(results.map((r) => r.committed)).toEqual(obs.committed);
      expect(results.map((r) => r.snapshot.val()).sort()).toEqual(obs.finalSnapshotsSorted);

      const txAdminSnap = await adminDb.ref(transactionPath).get();
      expect(txAdminSnap.val()).toBe(obs.transactionTerminal);
    });

    it('rejects with a codeless plain Error("maxretry") after 25 conflicting CAS attempts (M37h)', async () => {
      const ctx = await createContext();
      const first = await ctx.newClient('maxretry-first');
      const exhaustedPath = `${ctx.base}/concurrent-transforms/maxretry`;
      const target = ctx.rtdb.ref(first.db, exhaustedPath);
      await ctx.rtdb.set(target, 0);

      let attempts = 0;
      let caught: unknown = null;
      try {
        await ctx.rtdb.runTransaction(target, (current) => {
          attempts += 1;
          void ctx.rtdb.set(target, attempts + 100);
          const base = (current as number | null) ?? 0;
          return base + 1;
        });
      } catch (err) {
        caught = err;
      }

      expect(attempts).toBe(25);
      expect(caught).toBeInstanceOf(Error);
      const maxRetryErr = caught as Error & { code?: unknown };
      expect('code' in maxRetryErr).toBe(false);
      expect(maxRetryErr.name).toBe('Error');
      expect(maxRetryErr.message).toBe('maxretry');
    });
  });
}
