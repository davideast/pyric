import { it } from 'bun:test';
import { scenario } from '../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-servertimestamp-pending-echo.scenario.ts';
import { CACHED_INITIAL_SNAPSHOT, expectReplay, load, runInPage } from './support.ts';

const FINDING = `FW-10: the pending echo reads null by default, a Timestamp under estimate and the prior value under previous; ${CACHED_INITIAL_SNAPSHOT}`;
const old = { none: 'old', estimate: 'old', previous: 'old' };
const resolved = { none: 'Timestamp', estimate: 'Timestamp', previous: 'Timestamp' };

it('firestore-servertimestamp-pending-echo', async () => {
  const production = load('firestore-servertimestamp-pending-echo');
  const pyric = await runInPage(scenario);
  expectReplay({
    production,
    pyric,
    pins: [
      {
        key: 'docEvents',
        finding: FINDING,
        production: [
          { pending: false, fromCache: true, ...old },
          { pending: false, fromCache: false, ...old },
          { pending: true, fromCache: false, none: null, estimate: 'Timestamp', previous: 'old' },
          { pending: false, fromCache: false, ...resolved },
        ],
        pyric: [
          { pending: false, fromCache: false, ...old },
          { pending: false, fromCache: false, ...resolved },
          { pending: false, fromCache: false, ...resolved },
        ],
      },
      {
        key: 'queryEvents',
        finding: FINDING,
        production: [
          { pending: false, docPending: false, none: 'old', previous: 'old' },
          { pending: false, docPending: false, none: 'old', previous: 'old' },
          { pending: true, docPending: true, none: null, previous: 'old' },
          { pending: false, docPending: false, none: 'Timestamp', previous: 'Timestamp' },
        ],
        pyric: [
          { pending: false, docPending: false, none: 'old', previous: 'old' },
          { pending: true, docPending: false, none: 'Timestamp', previous: 'Timestamp' },
          { pending: false, docPending: false, none: 'Timestamp', previous: 'Timestamp' },
        ],
      },
    ],
  });
});
