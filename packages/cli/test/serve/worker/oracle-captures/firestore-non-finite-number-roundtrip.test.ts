import { it } from 'bun:test';
import { scenario } from '../../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-non-finite-number-roundtrip.scenario.ts';
import { expectReplay, load, restoreSharedWorker, servedFirestoreContext } from './support.ts';

restoreSharedWorker();

it('firestore-non-finite-number-roundtrip, served', async () => {
  expectReplay({
    production: load('firestore-non-finite-number-roundtrip'),
    pyric: await scenario.run(await servedFirestoreContext()),
    pins: [
      {
        key: 'read',
        finding: 'FP-1: NaN, Infinity, -Infinity and -0 read back unchanged',
        production: { nan: 'NaN', inf: 'Infinity', ninf: '-Infinity', neg0: '-0', nul: null },
        pyric: { nan: null, inf: null, ninf: null, neg0: 0, nul: null },
      },
      { key: 'eq0', finding: 'FL-31: == 0 matches a -0 doc', production: ['neg0'], pyric: [] },
    ],
  });
});
