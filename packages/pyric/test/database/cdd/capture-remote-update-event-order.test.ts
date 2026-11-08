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
      pins: [],
    });
  });

  row('priority-change-child-changed', async () => {
    // Production and sandbox both fire child_changed for a priority-only change.
    const production = afterPriority(obs('rtdb-modular-remote-update-event-order').log);
    const pyric = afterPriority((await runInPage(scenario)).log);
    expect(production).toContain('R changed a');
    expect(pyric).toContain('R changed a');
  });

  row('priority-change-child-moved', async () => {
    // A query with no orderBy fires child_moved for a priority change in both production and sandbox.
    const production = afterPriority(obs('rtdb-modular-remote-update-event-order').log);
    const pyric = afterPriority((await runInPage(scenario)).log);
    expect(production).toContain('L moved a');
    expect(pyric).toContain('L moved a');
  });

  row('val-key-order', async () => {
    // RT-7, fixed in #1371: val() keys follow priority, then key order, as production's do.
    expect((await runInPage(scenario)).valKeys).toEqual(obs('rtdb-modular-remote-update-event-order').valKeys);
  });

  row('served-event-order', async () => {
    expect(obs('rtdb-modular-remote-update-event-order').log).toEqual(PRODUCTION_LOG);
    expect((await runInPage(scenario)).log).toEqual(PRODUCTION_LOG);
  });
});
