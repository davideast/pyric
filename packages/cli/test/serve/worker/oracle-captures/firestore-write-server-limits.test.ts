import { it } from 'bun:test';
import { scenario as mapDepthScenario } from '../../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-write-map-depth-limit.scenario.ts';
import { scenario as serverLimitsScenario } from '../../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-write-server-limits.scenario.ts';
import { hostedFirestoreContext } from './hosted-firestore-support.ts';
import { expectReplay, load, restoreSharedWorker, servedFirestoreContext, withoutMessages } from './support.ts';

restoreSharedWorker();

const MAP_DEPTH_UNSETTLED = {
  'maps 101': 'production did not settle within 15 s',
  'maps 102': 'production did not settle within 15 s',
};

it('firestore-write-server-limits, served SharedWorker', async () => {
  expectReplay({
    production: withoutMessages(load('firestore-write-server-limits')),
    pyric: withoutMessages(await serverLimitsScenario.run(await servedFirestoreContext())),
    pins: [],
  });
});

it('firestore-write-server-limits, served Node host', async () => {
  expectReplay({
    production: withoutMessages(load('firestore-write-server-limits')),
    pyric: withoutMessages(await serverLimitsScenario.run(await hostedFirestoreContext())),
    pins: [],
  });
});

it('firestore-write-map-depth-limit, served SharedWorker', async () => {
  expectReplay({
    production: withoutMessages(load('firestore-write-map-depth-limit')),
    pyric: withoutMessages(await mapDepthScenario.run(await servedFirestoreContext())),
    pins: [],
    notCompared: MAP_DEPTH_UNSETTLED,
  });
});

it('firestore-write-map-depth-limit, served Node host', async () => {
  expectReplay({
    production: withoutMessages(load('firestore-write-map-depth-limit')),
    pyric: withoutMessages(await mapDepthScenario.run(await hostedFirestoreContext())),
    pins: [],
    notCompared: MAP_DEPTH_UNSETTLED,
  });
});
