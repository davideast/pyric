import { it } from 'bun:test';
import { scenario } from '../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-aggregate-field-semantics.scenario.ts';
import { expectReplay, load, runInPage, withoutMessages } from './support.ts';

it('firestore-aggregate-field-semantics', async () => {
  const production = withoutMessages(load('firestore-aggregate-field-semantics'));
  const pyric = withoutMessages(await runInPage(scenario));
  expectReplay({
    production,
    pyric,
    pins: [
      {
        key: 'multi',
        finding: 'FL-30: aggregations on several fields need a composite index',
        production: { error: 'failed-precondition' },
        pyric: { n: 4, sx: 6, sy: 16, ay: 16 / 3 },
      },
      {
        key: 'nullField',
        finding: 'FL-30: aggregations on several fields need a composite index',
        production: { error: 'failed-precondition' },
        pyric: { n: 2, sx: 3, sy: 4 },
      },
    ],
  });
});
