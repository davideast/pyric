import { describe, it } from 'bun:test';
import { scenario } from '../../../../conformance/src/capture/sdk-scenarios/rtdb/rtdb-modular-priority-window-limit-to-last.scenario.ts';
import { expectReplay, obs, runInPage } from './capture-replay.ts';

const row = (id: string, assertion: () => unknown | Promise<unknown>) => it(`rtdb-modular#${id}`, assertion);

// RT-17 was refuted by this capture: production gives the sandbox's four answers.
describe('SDK hunt captures: priority windows with limitToLast', () => {
  row('priority-window-limit-to-last', async () => {
    expectReplay({ production: obs('rtdb-modular-priority-window-limit-to-last'), pyric: await runInPage(scenario) });
  });
});
