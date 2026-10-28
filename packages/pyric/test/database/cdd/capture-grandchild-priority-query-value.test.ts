import { describe, it } from 'bun:test';
import { scenario } from '../../../../conformance/src/capture/sdk-scenarios/rtdb/rtdb-modular-grandchild-priority-query-value.scenario.ts';
import { expectReplay, obs, runInPage } from './capture-replay.ts';

const row = (id: string, assertion: () => unknown | Promise<unknown>) => it(`rtdb-modular#${id}`, assertion);

const FINDING = "RP-8: a grandchild's priority change fires a value event on every listener above it, queries included";

describe('SDK hunt captures: a grandchild priority change', () => {
  row('grandchild-priority-query-value', async () => {
    expectReplay({
      production: obs('rtdb-modular-grandchild-priority-query-value'),
      pyric: await runInPage(scenario),
      pins: [
        {
          key: 'afterPriority',
          finding: FINDING,
          production: { 'ref t': 2, 'ref t/items': 2, 't orderByKey limitToFirst(2)': 2, 't orderByKey startAt(b)': 2, 't/items orderByKey limitToFirst(2)': 2 },
          pyric: { 'ref t': 2, 'ref t/items': 2, 't orderByKey limitToFirst(2)': 1, 't orderByKey startAt(b)': 1, 't/items orderByKey limitToFirst(2)': 1 },
        },
        {
          key: 'afterControl',
          finding: FINDING,
          production: { 'ref t': 3, 'ref t/items': 3, 't orderByKey limitToFirst(2)': 3, 't orderByKey startAt(b)': 3, 't/items orderByKey limitToFirst(2)': 3 },
          pyric: { 'ref t': 3, 'ref t/items': 3, 't orderByKey limitToFirst(2)': 2, 't orderByKey startAt(b)': 2, 't/items orderByKey limitToFirst(2)': 2 },
        },
      ],
    });
  });
});
