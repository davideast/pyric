import { it } from 'bun:test';
import { scenario } from '../../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-query-doc-pending-writes.scenario.ts';
import { CACHED_INITIAL_SNAPSHOT } from '../../../../../conformance/src/capture/sdk-scenarios/replay-comparison.ts';
import { expectReplay, load, restoreSharedWorker, servedFirestoreContext } from './support.ts';

restoreSharedWorker();

it('firestore-query-doc-pending-writes, served', async () => {
  expectReplay({
    production: load('firestore-query-doc-pending-writes'),
    pyric: await scenario.run(await servedFirestoreContext()),
    pins: [
      {
        key: 'events',
        finding: `FP-5: only the written doc reports hasPendingWrites, not every doc in the snapshot; ${CACHED_INITIAL_SNAPSHOT}`,
        production: [
          { pw: false, docs: [['a', false]] },
          { pw: false, docs: [['a', false]] },
          { pw: true, docs: [['a', false], ['z', true]] },
          { pw: false, docs: [['a', false], ['z', false]] },
        ],
        pyric: [
          { pw: false, docs: [['a', false]] },
          { pw: true, docs: [['a', true], ['z', true]] },
          { pw: false, docs: [['a', false], ['z', false]] },
        ],
      },
    ],
  });
});
