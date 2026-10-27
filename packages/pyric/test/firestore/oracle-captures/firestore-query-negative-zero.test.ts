import { it } from 'bun:test';
import { scenario } from '../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-query-negative-zero.scenario.ts';
import { expectReplay, load, runInPage } from './support.ts';

const FINDING = 'FL-31: -0 and 0 are equal in == and !=';

it('firestore-query-negative-zero', async () => {
  const production = load('firestore-query-negative-zero');
  const pyric = await runInPage(scenario);
  expectReplay({
    production,
    pyric,
    pins: [
      { key: 'eq0', finding: FINDING, production: 'neg,pos', pyric: 'pos' },
      { key: 'eqNeg0', finding: FINDING, production: 'neg,pos', pyric: 'neg' },
      { key: 'ne0', finding: FINDING, production: 'one', pyric: 'neg,one' },
    ],
    notCompared: {
      log: 'production never logged notIn0, which did not settle within 15 s',
      notIn0: "production's getDocsFromServer did not settle within 15 s (FL-31's not-in sub-claim is NEEDS_RUNTIME)",
    },
  });
});
