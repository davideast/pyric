import { it } from 'bun:test';
import { scenario } from '../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-listener-local-write-metadata.scenario.ts';
import { expectReplay, load, runInPage } from './support.ts';

it('firestore-listener-local-write-metadata', async () => {
  const production = load('firestore-listener-local-write-metadata');
  const pyric = await runInPage(scenario);
  expectReplay({
    production,
    pyric,
    pins: [],
  });
});
