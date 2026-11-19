import { it } from 'bun:test';
import { scenario } from '../../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-non-finite-number-roundtrip.scenario.ts';
import { hostedFirestoreContext } from './hosted-firestore-support.ts';
import { expectReplay, load, restoreSharedWorker, servedFirestoreContext } from './support.ts';

restoreSharedWorker();

it('firestore-non-finite-number-roundtrip, served SharedWorker', async () => {
  expectReplay({
    production: load('firestore-non-finite-number-roundtrip'),
    pyric: await scenario.run(await servedFirestoreContext()),
    pins: [],
  });
});

it('firestore-non-finite-number-roundtrip, served Node host', async () => {
  expectReplay({
    production: load('firestore-non-finite-number-roundtrip'),
    pyric: await scenario.run(await hostedFirestoreContext()),
    pins: [],
  });
});
