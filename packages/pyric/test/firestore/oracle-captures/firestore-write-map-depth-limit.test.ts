import { it } from 'bun:test';
import { scenario } from '../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-write-map-depth-limit.scenario.ts';
import { expectReplay, load, runInPage, withoutMessages, type Pin } from './support.ts';

const FINDING = 'FW-14: the server refuses a value nested in 26 or more maps';
const refused = { ok: false, code: 'invalid-argument' };
const stored = (key: string): Pin => ({ key, finding: FINDING, production: refused, pyric: { ok: true } });

it('firestore-write-map-depth-limit', async () => {
  const production = withoutMessages(load('firestore-write-map-depth-limit'));
  const pyric = withoutMessages(await runInPage(scenario));
  expectReplay({
    production,
    pyric,
    pins: [stored('maps 26'), stored('maps 41')],
    notCompared: {
      'maps 101': 'production did not settle within 15 s',
      'maps 102': 'production did not settle within 15 s',
    },
  });
});
