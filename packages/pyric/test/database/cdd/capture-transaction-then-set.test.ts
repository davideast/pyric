import { describe, it } from 'bun:test';
import { scenario as cold } from '../../../../conformance/src/capture/sdk-scenarios/rtdb/rtdb-modular-transaction-then-set.scenario.ts';
import { scenario as warm } from '../../../../conformance/src/capture/sdk-scenarios/rtdb/rtdb-modular-transaction-then-set-warm.scenario.ts';
import { expectReplay, obs, runInPage } from './capture-replay.ts';

const row = (id: string, assertion: () => unknown | Promise<unknown>) => it(`rtdb-modular#${id}`, assertion);

const RT_15 = "RT-15: a cold client's transaction followed by set fails with Error('set')";
const RT_16 = 'RT-16: a cold client first calls the update function with null, so abort-if-missing aborts';
const sandboxCommit = { args: [1], tx: { committed: true, val: 2 }, set: 'ok', final: 100 };
const coldFailure = { args: [null], tx: { error: 'set', code: null }, set: 'ok', final: 100 };

describe('SDK hunt captures: runTransaction then set', () => {
  row('transaction-then-set-cold', async () => {
    expectReplay({
      production: obs('rtdb-modular-transaction-then-set'),
      pyric: await runInPage(cold),
      pins: [
        { key: 'cold', finding: RT_15, production: coldFailure, pyric: sandboxCommit },
        { key: 'warm', finding: `${RT_15} (this client's onlyOnce listener left it cold)`, production: coldFailure, pyric: sandboxCommit },
        {
          key: 'abortIfMissing',
          finding: RT_16,
          production: { args: [null], abort: { committed: false, val: null }, final: 1 },
          pyric: { args: [1], abort: { committed: true, val: 2 }, final: 2 },
        },
      ],
    });
    // A client that holds a listener commits in production too, as the sandbox does.
    expectReplay({ production: obs('rtdb-modular-transaction-then-set-warm'), pyric: await runInPage(warm) });
  });

  // RP-4 is a served-plane finding, pinned in
  // packages/cli/test/serve/worker/oracle-captures/rtdb-transaction-then-set.test.ts.
  // The sandbox side: a warm client's transaction commits once and the set lands on top.
  row('served-transaction-then-set', async () => {
    expectReplay({ production: obs('rtdb-modular-transaction-then-set-warm'), pyric: await runInPage(warm) });
  });
});
