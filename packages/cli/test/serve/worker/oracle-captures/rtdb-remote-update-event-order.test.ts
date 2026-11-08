import { it } from 'bun:test';
import { scenario } from '../../../../../conformance/src/capture/sdk-scenarios/rtdb/rtdb-modular-remote-update-event-order.scenario.ts';
import { expectReplay, load, restoreSharedWorker, servedRtdbContext } from './support.ts';

restoreSharedWorker();

it('rtdb-modular-remote-update-event-order, served', async () => {
  expectReplay({
    production: load('rtdb-modular-remote-update-event-order'),
    pyric: await scenario.run(await servedRtdbContext()),
    pins: [],
  });
});
