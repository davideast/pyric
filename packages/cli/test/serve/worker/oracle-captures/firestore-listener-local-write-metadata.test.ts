import { it } from 'bun:test';
import { scenario } from '../../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-listener-local-write-metadata.scenario.ts';
import { hostedFirestoreContext } from './hosted-firestore-support.ts';
import { expectReplay, load, restoreSharedWorker, servedFirestoreContext } from './support.ts';

restoreSharedWorker();

it('firestore-listener-local-write-metadata, served SharedWorker', async () => {
  expectReplay({
    production: load('firestore-listener-local-write-metadata'),
    pyric: await scenario.run(await servedFirestoreContext()),
    pins: [],
  });
});

it('firestore-listener-local-write-metadata, served Node host', async () => {
  expectReplay({
    production: load('firestore-listener-local-write-metadata'),
    pyric: await scenario.run(await hostedFirestoreContext()),
    pins: [],
  });
});
