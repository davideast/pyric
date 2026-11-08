import { it } from 'bun:test';
import { scenario } from '../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-query-disjunction-limits.scenario.ts';
import { expectReplay, load, runInPage, withoutMessages } from './support.ts';

it('firestore-query-disjunction-limits', async () => {
  const production = withoutMessages(load('firestore-query-disjunction-limits'));
  const pyric = withoutMessages(await runInPage(scenario));
  expectReplay({
    production,
    pyric,
    pins: [],
  });
});
