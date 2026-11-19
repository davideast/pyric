import { it } from 'bun:test';
import { scenario } from '../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-offline-denied-write.scenario.ts';
import { expectReplay, load, runInPage } from './support.ts';

it('firestore-offline-denied-write', async () => {
  const production = load('firestore-offline-denied-write');
  const pyric = await runInPage(scenario);
  expectReplay({
    production,
    pyric,
    pins: [],
  });
});
