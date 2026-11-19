import { it } from 'bun:test';
import { scenario } from '../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-query-doc-pending-writes.scenario.ts';
import { expectReplay, load, runInPage } from './support.ts';

it('firestore-query-doc-pending-writes', async () => {
  const production = load('firestore-query-doc-pending-writes');
  const pyric = await runInPage(scenario);
  expectReplay({
    production,
    pyric,
    pins: [],
  });
});
