import { it } from 'bun:test';
import { scenario } from '../../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-query-disjunction-limits.scenario.ts';
import { hostedFirestoreContext } from './hosted-firestore-support.ts';
import { expectReplay, load, restoreSharedWorker, servedFirestoreContext, withoutMessages } from './support.ts';

restoreSharedWorker();

it('firestore-query-disjunction-limits, served SharedWorker', async () => {
  expectReplay({
    production: withoutMessages(load('firestore-query-disjunction-limits')),
    pyric: withoutMessages(await scenario.run(await servedFirestoreContext())),
    pins: [],
  });
});

it('firestore-query-disjunction-limits, served Node host', async () => {
  expectReplay({
    production: withoutMessages(load('firestore-query-disjunction-limits')),
    pyric: withoutMessages(await scenario.run(await hostedFirestoreContext())),
    pins: [],
  });
});
