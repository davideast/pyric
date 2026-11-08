import { it } from 'bun:test';
import { scenario } from '../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-write-server-limits.scenario.ts';
import { expectReplay, load, runInPage, withoutMessages } from './support.ts';

it('firestore-write-server-limits', async () => {
  const production = withoutMessages(load('firestore-write-server-limits'));
  const pyric = withoutMessages(await runInPage(scenario));
  expectReplay({
    production,
    pyric,
    pins: [],
  });
});
