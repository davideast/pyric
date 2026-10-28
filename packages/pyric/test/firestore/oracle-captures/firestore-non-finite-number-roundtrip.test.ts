import { it } from 'bun:test';
import { scenario } from '../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-non-finite-number-roundtrip.scenario.ts';
import { expectReplay, load, runInPage } from './support.ts';

// The in-page sandbox keeps NaN, Infinity, -Infinity and -0 as production
// does. The served planes do not (FP-1): packages/cli/test/serve/worker/oracle-captures/.
it('firestore-non-finite-number-roundtrip', async () => {
  const production = load('firestore-non-finite-number-roundtrip');
  const pyric = await runInPage(scenario);
  expectReplay({ production, pyric });
});
