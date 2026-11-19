import { expect, it } from 'bun:test';
import { scenario as cold } from '../../../../../conformance/src/capture/sdk-scenarios/rtdb/rtdb-modular-transaction-then-set.scenario.ts';
import { scenario as warm } from '../../../../../conformance/src/capture/sdk-scenarios/rtdb/rtdb-modular-transaction-then-set-warm.scenario.ts';
import { expectReplay, hostedRtdbContext, load, restoreSharedWorker, servedRtdbContext } from './support.ts';

restoreSharedWorker();

it('rtdb-modular-transaction-then-set, served SharedWorker', async () => {
  expectReplay({
    production: load('rtdb-modular-transaction-then-set'),
    pyric: await cold.run(await servedRtdbContext()),
    pins: [],
  });
});

it('rtdb-modular-transaction-then-set, served Node host', async () => {
  expectReplay({
    production: load('rtdb-modular-transaction-then-set'),
    pyric: await cold.run(await hostedRtdbContext()),
    pins: [],
  });
});

it('rtdb-modular-transaction-then-set-warm, served SharedWorker', async () => {
  expectReplay({
    production: load('rtdb-modular-transaction-then-set-warm'),
    pyric: await warm.run(await servedRtdbContext()),
    pins: [],
  });
});

it('rtdb-modular-transaction-then-set-warm, served Node host', async () => {
  expectReplay({
    production: load('rtdb-modular-transaction-then-set-warm'),
    pyric: await warm.run(await hostedRtdbContext()),
    pins: [],
  });
});

for (const [planeName, createContext] of [
  ['served SharedWorker', servedRtdbContext],
  ['served Node host', hostedRtdbContext],
] as const) {
  it(`rtdb-modular-runtransaction-current-value-arg cold secondary client (${planeName})`, async () => {
    const obs = load('rtdb-modular-runtransaction-current-value-arg') as {
      seededArgs: Array<{ raw: unknown; type: string; isNull: boolean; isUndefined: boolean }>;
    };
    const ctx = await createContext();
    const seeder = await ctx.newClient('seeder');
    const coldClient = await ctx.newClient('cold-reader');
    const path = `${ctx.base}/current-value-arg/user`;
    await ctx.rtdb.set(ctx.rtdb.ref(seeder.db, path), { count: 7, name: 'alice' });

    const seen: Array<{ raw: unknown; type: string; isNull: boolean; isUndefined: boolean }> = [];
    const result = await ctx.rtdb.runTransaction<{ count: number; name: string }>(
      ctx.rtdb.ref(coldClient.db, path),
      (current) => {
        seen.push({
          raw: current,
          type: typeof current,
          isNull: current === null,
          isUndefined: current === undefined,
        });
        if (current !== null && typeof current === 'object') {
          return { ...current, count: current.count + 1 };
        }
        return { count: 1, name: 'speculative' };
      },
    );
    expect(seen).toEqual(obs.seededArgs);
    expect(result.committed).toBe(true);
    expect(result.snapshot.val()).toEqual({ count: 8, name: 'alice' });
  });
}
