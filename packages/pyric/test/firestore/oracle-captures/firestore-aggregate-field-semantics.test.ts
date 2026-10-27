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
        key: 'countAndSumY',
        finding: 'FL-27: count with sum(y) counts only docs that have y',
        production: { n: 3, sy: 16 },
        pyric: { n: 4, sy: 16 },
      },
      {
        key: 'nullField',
        finding: 'FL-30: aggregations on several fields need a composite index',
        production: { error: 'failed-precondition' },
        pyric: { n: 2, sx: 3, sy: 4 },
      },
      {
        key: 'nan',
        finding: 'FL-28: sum and average over a NaN value are NaN',
        production: { s: 'NaN', a: 'NaN', n: 3 },
        pyric: { s: 3, a: 1.5, n: 3 },
      },
      {
        key: 'inf',
        finding: 'FL-28: sum and average over Infinity are Infinity',
        production: { s: 'Infinity', a: 'Infinity', n: 2 },
        pyric: { s: 1, a: 1, n: 2 },
      },
    ],
  });
});
