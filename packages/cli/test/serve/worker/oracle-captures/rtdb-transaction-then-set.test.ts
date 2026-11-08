import { it } from 'bun:test';
import { scenario as cold } from '../../../../../conformance/src/capture/sdk-scenarios/rtdb/rtdb-modular-transaction-then-set.scenario.ts';
import { scenario as warm } from '../../../../../conformance/src/capture/sdk-scenarios/rtdb/rtdb-modular-transaction-then-set-warm.scenario.ts';
import { expectReplay, load, restoreSharedWorker, servedRtdbContext } from './support.ts';

restoreSharedWorker();

const RT_15 = "RT-15: a cold client's transaction followed by set fails with Error('set')";
const sandboxCommit = { args: [1], tx: { committed: true, val: 2 }, set: 'ok', final: 100 };
const coldFailure = { args: [null], tx: { error: 'set', code: null }, set: 'ok', final: 100 };

it('rtdb-modular-transaction-then-set, served', async () => {
  expectReplay({
    production: load('rtdb-modular-transaction-then-set'),
    pyric: await cold.run(await servedRtdbContext()),
    pins: [
      { key: 'cold', finding: RT_15, production: coldFailure, pyric: sandboxCommit },
      { key: 'warm', finding: `${RT_15} (this client's onlyOnce listener left it cold)`, production: coldFailure, pyric: sandboxCommit },
      {
        key: 'abortIfMissing',
        finding: 'RT-16: a cold client first calls the update function with null, so abort-if-missing aborts',
        production: { args: [null], abort: { committed: false, val: null }, final: 1 },
        pyric: { args: [1], abort: { committed: true, val: 2 }, final: 2 },
      },
    ],
  });
});

it('rtdb-modular-transaction-then-set-warm, served', async () => {
  expectReplay({
    production: load('rtdb-modular-transaction-then-set-warm'),
    pyric: await warm.run(await servedRtdbContext()),
    pins: [],
  });
});
