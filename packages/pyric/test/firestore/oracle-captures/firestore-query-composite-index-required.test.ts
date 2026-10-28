import { it } from 'bun:test';
import { scenario } from '../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-query-composite-index-required.scenario.ts';
import { expectReplay, load, runInPage, type Pin } from './support.ts';

const FINDING = 'FL-30: a query that needs a composite index fails with failed-precondition';
const needsIndex = { code: 'failed-precondition', requiresIndex: true };
const runs = (key: string, ids: string): Pin => ({ key, finding: FINDING, production: needsIndex, pyric: { ok: ids } });

it('firestore-query-composite-index-required', async () => {
  const production = load('firestore-query-composite-index-required');
  const pyric = await runInPage(scenario);
  expectReplay({
    production,
    pyric,
    pins: [
      runs('eqPlusOrderOther', 'r,q'),
      runs('rangePlusOrderOther', 'r,p,q,s'),
      // Implicit order follows field-path order since #1364 (FL-4).
      runs('twoRangeFields', 'r,q,p,s'),
      runs('arrayContainsPlusOrder', 'r,q'),
    ],
  });
});
