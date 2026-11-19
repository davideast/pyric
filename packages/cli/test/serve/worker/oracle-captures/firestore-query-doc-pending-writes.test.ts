import { it } from 'bun:test';
import { scenario } from '../../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-query-doc-pending-writes.scenario.ts';
import { hostedFirestoreContext } from './hosted-firestore-support.ts';
import { expectReplay, load, restoreSharedWorker, servedFirestoreContext } from './support.ts';

restoreSharedWorker();

it('firestore-query-doc-pending-writes, served SharedWorker', async () => {
  expectReplay({
    production: load('firestore-query-doc-pending-writes'),
    pyric: await scenario.run(await servedFirestoreContext()),
    pins: [],
  });
});

it('firestore-query-doc-pending-writes, served Node host', async () => {
  expectReplay({
    production: load('firestore-query-doc-pending-writes'),
    pyric: await scenario.run(await hostedFirestoreContext()),
    pins: [],
  });
});
