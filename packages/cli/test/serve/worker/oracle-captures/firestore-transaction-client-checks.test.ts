import { it } from 'bun:test';
import { scenario } from '../../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-transaction-client-checks.scenario.ts';
import { hostedFirestoreContext } from './hosted-firestore-support.ts';
import { expectReplay, load, restoreSharedWorker, servedFirestoreContext, withoutMessages } from './support.ts';

restoreSharedWorker();

it('firestore-transaction-client-checks, served SharedWorker', async () => {
  expectReplay({
    production: withoutMessages(load('firestore-transaction-client-checks')),
    pyric: withoutMessages(await scenario.run(await servedFirestoreContext())),
    pins: [],
  });
});

it('firestore-transaction-client-checks, served Node host', async () => {
  expectReplay({
    production: withoutMessages(load('firestore-transaction-client-checks')),
    pyric: withoutMessages(await scenario.run(await hostedFirestoreContext())),
    pins: [],
  });
});
