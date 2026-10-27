import { it } from 'bun:test';
import { scenario } from '../../../../../conformance/src/capture/sdk-scenarios/rtdb/rtdb-modular-remote-update-event-order.scenario.ts';
import { expectReplay, load, restoreSharedWorker, servedRtdbContext } from './support.ts';

restoreSharedWorker();

it('rtdb-modular-remote-update-event-order, served', async () => {
  expectReplay({
    production: load('rtdb-modular-remote-update-event-order'),
    pyric: await scenario.run(await servedRtdbContext()),
    pins: [
      {
        key: 'log',
        finding: "RP-5: one write's events arrive in production's order, not listener by listener; RT-4: a priority change fires child_changed",
        production: [
          '-- update',
          'A changed x', 'A value',
          'R removed c', 'R added d', 'R changed a', 'R changed b', 'R value',
          'Q moved b', 'Q moved a', 'Q changed b', 'Q changed a',
          '-- setPriority a 9',
          'A value', 'R changed a', 'R value', 'Q moved a', 'Q changed a', 'L moved a',
        ],
        pyric: [
          '-- update',
          'R value', 'R added d', 'R changed a', 'R changed b', 'R removed c',
          'A value', 'A changed x',
          'Q changed b', 'Q changed a', 'Q moved b', 'Q moved a',
          '-- setPriority a 9',
          'R value', 'A value', 'L moved a',
        ],
      },
      {
        key: 'valKeys',
        finding: 'RT-7: val() keys follow priority, then key order',
        production: { ref: 'a,b,c', query: 'a,b,c' },
        pyric: { ref: 'b,a,c', query: 'b,c,a' },
      },
    ],
  });
});
