import { describe, expect, it } from 'bun:test';
import { scenario } from '../../../../conformance/src/capture/sdk-scenarios/rtdb/rtdb-modular-remote-update-event-order.scenario.ts';
import { expectReplay, obs, runInPage } from './capture-replay.ts';

const row = (id: string, assertion: () => unknown | Promise<unknown>) => it(`rtdb-modular#${id}`, assertion);

const PRODUCTION_LOG = [
  '-- update',
  'A changed x', 'A value',
  'R removed c', 'R added d', 'R changed a', 'R changed b', 'R value',
  'Q moved b', 'Q moved a', 'Q changed b', 'Q changed a',
  '-- setPriority a 9',
  'A value', 'R changed a', 'R value', 'Q moved a', 'Q changed a', 'L moved a',
];
const SANDBOX_LOG = [
  '-- update',
  'R value', 'A value',
  'Q changed b', 'Q changed a', 'Q moved b', 'Q moved a',
  'R added d', 'R changed a', 'R changed b', 'R removed c', 'A changed x',
  '-- setPriority a 9',
  'R value', 'A value',
];

const afterPriority = (log: unknown) => {
  const lines = log as string[];
  return lines.slice(lines.indexOf('-- setPriority a 9') + 1);
};

describe('SDK hunt captures: one remote update, then setPriority', () => {
  row('remote-update-event-order', async () => {
    expectReplay({
      production: obs('rtdb-modular-remote-update-event-order'),
      pyric: await runInPage(scenario),
      pins: [
        {
          key: 'log',
          finding: 'RT-2: deeper paths and child events fire before value; RT-3: child events go removed, added, moved, changed; RT-4; RT-5',
          production: PRODUCTION_LOG,
          pyric: SANDBOX_LOG,
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

  row('priority-change-child-changed', async () => {
    // RT-4: production fires child_changed for a priority-only change; the sandbox does not.
    const production = afterPriority(obs('rtdb-modular-remote-update-event-order').log);
    const pyric = afterPriority((await runInPage(scenario)).log);
    expect(production).toContain('R changed a');
    expect(pyric).not.toContain('R changed a');
  });

  row('priority-change-child-moved', async () => {
    // RT-5: a query with no orderBy fires child_moved for a priority change in production only.
    const production = afterPriority(obs('rtdb-modular-remote-update-event-order').log);
    const pyric = afterPriority((await runInPage(scenario)).log);
    expect(production).toContain('L moved a');
    expect(pyric).not.toContain('L moved a');
  });

  row('val-key-order', async () => {
    // RT-7, pinned on both sides in the remote-update-event-order row; this row's own fact.
    expect(obs('rtdb-modular-remote-update-event-order').valKeys).toEqual({ ref: 'a,b,c', query: 'a,b,c' });
    expect((await runInPage(scenario)).valKeys).toEqual({ ref: 'b,a,c', query: 'b,c,a' });
  });

  // RP-5 is a served-plane finding, pinned in
  // packages/cli/test/serve/worker/oracle-captures/rtdb-remote-update-event-order.test.ts.
  // The sandbox side is RT-2's order above.
  row('served-event-order', async () => {
    expect(obs('rtdb-modular-remote-update-event-order').log).toEqual(PRODUCTION_LOG);
    expect((await runInPage(scenario)).log).toEqual(SANDBOX_LOG);
  });
});
