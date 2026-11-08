import { it } from 'bun:test';
import { scenario } from '../../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-non-finite-number-roundtrip.scenario.ts';
import { expectReplay, load, restoreSharedWorker, servedFirestoreContext } from './support.ts';

restoreSharedWorker();

it('firestore-non-finite-number-roundtrip, served', async () => {
  expectReplay({
    production: load('firestore-non-finite-number-roundtrip'),
    pyric: await scenario.run(await servedFirestoreContext()),
    pins: [],
  });
});
