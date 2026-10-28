import { it } from 'bun:test';
import { scenario as cold } from '../../../../../conformance/src/capture/sdk-scenarios/rtdb/rtdb-modular-transaction-then-set.scenario.ts';
import { scenario as warm } from '../../../../../conformance/src/capture/sdk-scenarios/rtdb/rtdb-modular-transaction-then-set-warm.scenario.ts';
import { expectReplay, load, restoreSharedWorker, servedRtdbContext } from './support.ts';

restoreSharedWorker();

const RP_4 = "RP-4: the transaction does not rerun on the set's value and commit on top";
const reranOnSet = { args: [1, 100], tx: { committed: true, val: 101 }, set: 'ok', final: 101 };
const coldFailure = { args: [null], tx: { error: 'set', code: null }, set: 'ok', final: 100 };

it('rtdb-modular-transaction-then-set, served', async () => {
  expectReplay({
    production: load('rtdb-modular-transaction-then-set'),
    pyric: await cold.run(await servedRtdbContext()),
    pins: [
      { key: 'cold', finding: `${RP_4}; a cold client fails it with Error('set')`, production: coldFailure, pyric: reranOnSet },
      { key: 'warm', finding: `${RP_4}; this client's onlyOnce listener left it cold`, production: coldFailure, pyric: reranOnSet },
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
    pins: [
      { key: 'args', finding: RP_4, production: [1], pyric: [1, 100] },
      { key: 'tx', finding: RP_4, production: { committed: true, val: 2 }, pyric: { committed: true, val: 101 } },
      { key: 'final', finding: RP_4, production: 100, pyric: 101 },
    ],
  });
});
