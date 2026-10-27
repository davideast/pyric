import type { RtdbScenario, RtdbScenarioContext } from '../scenario-types.ts';

const SETTLE_MS = 10_000;

/**
 * runTransaction then set(100) at once, from a fresh client. With `warm`, an
 * onlyOnce listener runs first; it removes its own listen before the second
 * onValue attaches, so that client is cold as well (args [null] shows it).
 */
async function transactionThenSet(ctx: RtdbScenarioContext, seeder: RtdbScenarioContext['db'], name: string, warm: boolean) {
  const { rtdb, base } = ctx;
  const client = await ctx.newClient(name);
  const target = rtdb.ref(client.db, `${base}/${name}/n`);
  if (warm) {
    await new Promise<void>((resolve) => { rtdb.onValue(target, () => resolve(), { onlyOnce: true }); });
    rtdb.onValue(target, () => {});
  }
  const args: unknown[] = [];
  let tx: unknown = null;
  const transaction = rtdb.runTransaction(target, (value) => { args.push(value); return ((value as number | null) ?? 0) + 1; })
    .then(
      (result) => { tx = { committed: result.committed, val: result.snapshot.val() }; },
      (error: { message?: string; code?: string }) => { tx = { error: error.message, code: error.code ?? null }; },
    );
  const write = rtdb.set(target, 100).then(() => 'ok', (error: Error) => `err ${error.message}`);
  await ctx.within(Promise.all([transaction, write]), SETTLE_MS);
  const final = (await rtdb.get(rtdb.ref(seeder, `${base}/${name}/n`))).val();
  return { args, tx, set: await write, final };
}

export const scenario: RtdbScenario = {
  observation: {
    name: 'rtdb-modular-transaction-then-set',
    rowIds: ['rtdb-modular#transaction-then-set-cold', 'rtdb-modular#served-transaction-then-set', 'rtdb-modular#M37b'],
    description: 'Fresh clients call runTransaction on a seeded path and then set(100) at once. The "warm" scenario attaches its listener with onlyOnce first, which leaves the client cold too. A third fresh client runs an update function that aborts when the current value is null. Records the update function arguments, the outcome and the final value. Captured on the dedicated RTDB oracle instance.',
  },
  async run(ctx) {
    const { rtdb, base } = ctx;
    const seeder = await ctx.newClient('seed');
    await rtdb.set(rtdb.ref(seeder.db, `${base}/cold/n`), 1);
    await rtdb.set(rtdb.ref(seeder.db, `${base}/warm/n`), 1);
    await rtdb.set(rtdb.ref(seeder.db, `${base}/abort/n`), 1);
    const abortClient = await ctx.newClient('abort');
    const args: unknown[] = [];
    let abort: unknown;
    try {
      const result = await rtdb.runTransaction(rtdb.ref(abortClient.db, `${base}/abort/n`), (value) => {
        args.push(value);
        return value === null ? undefined : (value as number) + 1;
      });
      abort = { committed: result.committed, val: result.snapshot.val() };
    } catch (error) {
      abort = { error: (error as Error).message };
    }
    const abortFinal = (await rtdb.get(rtdb.ref(seeder.db, `${base}/abort/n`))).val();
    return {
      cold: await transactionThenSet(ctx, seeder.db, 'cold', false),
      warm: await transactionThenSet(ctx, seeder.db, 'warm', true),
      abortIfMissing: { args, abort, final: abortFinal },
    };
  },
};
