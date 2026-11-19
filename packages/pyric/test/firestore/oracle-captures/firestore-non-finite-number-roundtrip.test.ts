import { it } from 'bun:test';
import { scenario } from '../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-non-finite-number-roundtrip.scenario.ts';
import { expectReplay, load, runInPage } from './support.ts';

// Served SharedWorker and Node host planes replay this capture in
// packages/cli/test/serve/worker/oracle-captures/firestore-non-finite-number-roundtrip.test.ts (FP-1).
it('firestore-non-finite-number-roundtrip', async () => {
  const production = load('firestore-non-finite-number-roundtrip');
  const pyric = await runInPage(scenario);
  expectReplay({ production, pyric });
});
