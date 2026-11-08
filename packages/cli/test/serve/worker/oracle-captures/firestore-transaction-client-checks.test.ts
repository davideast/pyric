import { it } from 'bun:test';
import { scenario } from '../../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-transaction-client-checks.scenario.ts';
import { expectReplay, load, restoreSharedWorker, servedFirestoreContext } from './support.ts';

restoreSharedWorker();

it('firestore-transaction-client-checks, served', async () => {
  expectReplay({
    production: load('firestore-transaction-client-checks'),
    pyric: await scenario.run(await servedFirestoreContext()),
    pins: [],
  });
});
