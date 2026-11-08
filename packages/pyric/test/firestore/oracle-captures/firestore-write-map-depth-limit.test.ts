import { it } from 'bun:test';
import { scenario } from '../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-write-map-depth-limit.scenario.ts';
import { expectReplay, load, runInPage, withoutMessages } from './support.ts';

it('firestore-write-map-depth-limit', async () => {
  const production = withoutMessages(load('firestore-write-map-depth-limit'));
  const pyric = withoutMessages(await runInPage(scenario));
  expectReplay({
    production,
    pyric,
    pins: [],
    notCompared: {
      'maps 101': 'production did not settle within 15 s',
      'maps 102': 'production did not settle within 15 s',
    },
  });
});
