import { it } from 'bun:test';
import { scenario } from '../../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-offline-denied-write.scenario.ts';
import { hostedFirestoreContext } from './hosted-firestore-support.ts';
import { expectReplay, load, restoreSharedWorker, servedFirestoreContext } from './support.ts';

restoreSharedWorker();

it('firestore-offline-denied-write, served SharedWorker', async () => {
  expectReplay({
    production: load('firestore-offline-denied-write'),
    pyric: await scenario.run(await servedFirestoreContext()),
    pins: [],
  });
});

it('firestore-offline-denied-write, served Node host', async () => {
  expectReplay({
    production: load('firestore-offline-denied-write'),
    pyric: await scenario.run(await hostedFirestoreContext()),
    pins: [],
  });
});
