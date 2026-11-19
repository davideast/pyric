import { describe, it } from 'bun:test';
import { scenario as cold } from '../../../../conformance/src/capture/sdk-scenarios/rtdb/rtdb-modular-transaction-then-set.scenario.ts';
import { scenario as warm } from '../../../../conformance/src/capture/sdk-scenarios/rtdb/rtdb-modular-transaction-then-set-warm.scenario.ts';
import { expectReplay, obs, runInPage } from './capture-replay.ts';

const row = (id: string, assertion: () => unknown | Promise<unknown>) => it(`rtdb-modular#${id}`, assertion);

describe('SDK hunt captures: runTransaction then set', () => {
  row('transaction-then-set-cold', async () => {
    expectReplay({
      production: obs('rtdb-modular-transaction-then-set'),
      pyric: await runInPage(cold),
    });
    expectReplay({
      production: obs('rtdb-modular-transaction-then-set-warm'),
      pyric: await runInPage(warm),
    });
  });

  // RP-4 is a served-plane finding, replayed in
  // packages/cli/test/serve/worker/oracle-captures/rtdb-transaction-then-set.test.ts.
  // The sandbox side: a warm client's transaction commits once and the set lands on top.
  row('served-transaction-then-set', async () => {
    expectReplay({ production: obs('rtdb-modular-transaction-then-set-warm'), pyric: await runInPage(warm) });
  });
});
