import { it } from 'bun:test';
import { scenario } from '../../../../../conformance/src/capture/sdk-scenarios/rtdb/rtdb-modular-grandchild-priority-query-value.scenario.ts';
import { expectReplay, hostedRtdbContext, load, restoreSharedWorker, servedRtdbContext } from './support.ts';

restoreSharedWorker();

it('rtdb-modular-grandchild-priority-query-value, served SharedWorker', async () => {
  expectReplay({
    production: load('rtdb-modular-grandchild-priority-query-value'),
    pyric: await scenario.run(await servedRtdbContext()),
    pins: [],
  });
});

it('rtdb-modular-grandchild-priority-query-value, served Node host', async () => {
  expectReplay({
    production: load('rtdb-modular-grandchild-priority-query-value'),
    pyric: await scenario.run(await hostedRtdbContext()),
    pins: [],
  });
});
