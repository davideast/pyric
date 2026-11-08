import { describe, it } from 'bun:test';
import { scenario } from '../../../../conformance/src/capture/sdk-scenarios/rtdb/rtdb-modular-grandchild-priority-query-value.scenario.ts';
import { expectReplay, obs, runInPage } from './capture-replay.ts';

const row = (id: string, assertion: () => unknown | Promise<unknown>) => it(`rtdb-modular#${id}`, assertion);

describe('SDK hunt captures: a grandchild priority change', () => {
  row('grandchild-priority-query-value', async () => {
    expectReplay({
      production: obs('rtdb-modular-grandchild-priority-query-value'),
      pyric: await runInPage(scenario),
      pins: [],
    });
  });
});
