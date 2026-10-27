import { it } from 'bun:test';
import { scenario } from '../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-query-disjunction-limits.scenario.ts';
import { expectReplay, load, runInPage, withoutMessages, type Pin } from './support.ts';

const FINDING = 'FL-29: the server refuses queries past its disjunction limits';
const refused = { at: 'getDocs', code: 'invalid-argument' };
const limit = (key: string, pyricSize: number): Pin => ({ key, finding: FINDING, production: refused, pyric: { ok: pyricSize } });

it('firestore-query-disjunction-limits', async () => {
  const production = withoutMessages(load('firestore-query-disjunction-limits'));
  const pyric = withoutMessages(await runInPage(scenario));
  expectReplay({
    production,
    pyric,
    pins: [limit('in31', 1), limit('notIn11', 0), limit('aca31', 1), limit('or31', 1), limit('dnf36', 1)],
  });
});
