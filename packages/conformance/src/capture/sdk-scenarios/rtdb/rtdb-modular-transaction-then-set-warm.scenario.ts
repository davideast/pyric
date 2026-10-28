import type { RtdbScenario } from '../scenario-types.ts';

const SETTLE_MS = 10_000;

export const scenario: RtdbScenario = {
  observation: {
    name: 'rtdb-modular-transaction-then-set-warm',
    rowIds: ['rtdb-modular#transaction-then-set-cold', 'rtdb-modular#served-transaction-then-set'],
    description: 'A client that holds a listener on a seeded path calls runTransaction and then set(100) at once. Records the update function arguments, the outcome and the final value. Captured on the dedicated RTDB oracle instance.',
  },
  async run(ctx) {
    const { rtdb, base } = ctx;
    const seeder = await ctx.newClient('seed');
    await rtdb.set(rtdb.ref(seeder.db, `${base}/warm2/n`), 1);
    const client = await ctx.newClient('warm2');
    const target = rtdb.ref(client.db, `${base}/warm2/n`);
    const seen: unknown[] = [];
    await new Promise<void>((resolve) => { rtdb.onValue(target, (s) => { seen.push(s.val()); resolve(); }); });
    const args: unknown[] = [];
    let tx: unknown = null;
    const transaction = rtdb.runTransaction(target, (value) => { args.push(value); return ((value as number | null) ?? 0) + 1; })
      .then(
        (result) => { tx = { committed: result.committed, val: result.snapshot.val() }; },
        (error: Error) => { tx = { error: error.message }; },
      );
    const write = rtdb.set(target, 100).then(() => 'ok', (error: Error) => `err ${error.message}`);
    await ctx.within(Promise.all([transaction, write]), SETTLE_MS);
    const final = (await rtdb.get(rtdb.ref(seeder.db, `${base}/warm2/n`))).val();
    return { firstListenerValue: seen[0], args, tx, set: await write, final };
  },
};
