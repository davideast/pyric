import { it } from 'bun:test';
import { scenario } from '../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-query-doc-pending-writes.scenario.ts';
import { CACHED_INITIAL_SNAPSHOT, expectReplay, load, runInPage } from './support.ts';

// The served planes mark every doc pending instead (FP-5): packages/cli/test/serve/worker/oracle-captures/.
it('firestore-query-doc-pending-writes', async () => {
  const production = load('firestore-query-doc-pending-writes');
  const pyric = await runInPage(scenario);
  expectReplay({
    production,
    pyric,
    pins: [
      {
        key: 'events',
        finding: `FL-20: only the written doc reports hasPendingWrites; ${CACHED_INITIAL_SNAPSHOT}`,
        production: [
          { pw: false, docs: [['a', false]] },
          { pw: false, docs: [['a', false]] },
          { pw: true, docs: [['a', false], ['z', true]] },
          { pw: false, docs: [['a', false], ['z', false]] },
        ],
        pyric: [
          { pw: false, docs: [['a', false]] },
          { pw: true, docs: [['a', false], ['z', false]] },
          { pw: false, docs: [['a', false], ['z', false]] },
        ],
      },
    ],
  });
});
