import { it } from 'bun:test';
import { scenario } from '../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-servertimestamp-pending-echo.scenario.ts';
import { expectReplay, load, runInPage } from './support.ts';

it('firestore-servertimestamp-pending-echo', async () => {
  const production = load('firestore-servertimestamp-pending-echo');
  const pyric = await runInPage(scenario);
  expectReplay({
    production,
    pyric,
    pins: [],
  });
});
