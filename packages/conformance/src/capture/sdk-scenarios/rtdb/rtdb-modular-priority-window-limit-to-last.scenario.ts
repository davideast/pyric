import type { QueryConstraint } from 'firebase/database';
import type { RtdbScenario } from '../scenario-types.ts';

export const scenario: RtdbScenario = {
  observation: {
    name: 'rtdb-modular-priority-window-limit-to-last',
    rowIds: ['rtdb-modular#priority-window-limit-to-last'],
    description: 'onValue once from fresh clients over children with no priority: orderByPriority with endAt("1","A") and limitToLast(1), endBefore("1") and limitToLast(2), endAt("1","A") with no limit, and a default-order endAt(2) limitToLast(3) control. Records the keys. Captured on the dedicated RTDB oracle instance.',
  },
  rules: { '.read': 'auth != null', '.write': 'auth != null', r: { '.indexOn': '.value' } },
  async run(ctx) {
    const { rtdb, base } = ctx;
    const writer = await ctx.newClient('writer');
    await rtdb.set(rtdb.ref(writer.db, `${base}/r`), { '1': 'x', '10': 'x', A: 'x', a: 'x', b: 'x', z: 'x' });
    const queries: Record<string, () => QueryConstraint[]> = {
      'orderByPriority endAt("1","A") limitToLast(1)': () => [rtdb.orderByPriority(), rtdb.endAt('1', 'A'), rtdb.limitToLast(1)],
      'orderByPriority endBefore("1") limitToLast(2)': () => [rtdb.orderByPriority(), rtdb.endBefore('1'), rtdb.limitToLast(2)],
      'endAt(2) limitToLast(3) control': () => [rtdb.endAt(2), rtdb.limitToLast(3)],
      'orderByPriority endAt("1","A") no limit': () => [rtdb.orderByPriority(), rtdb.endAt('1', 'A')],
    };
    const out: Record<string, string> = {};
    for (const [label, constraints] of Object.entries(queries)) {
      const client = await ctx.newClient(`r-${Object.keys(out).length}`);
      out[label] = await new Promise<string>((resolve) => rtdb.onValue(
        rtdb.query(rtdb.ref(client.db, `${base}/r`), ...constraints()),
        (s) => {
          const keys: string[] = [];
          s.forEach((child) => { keys.push(child.key!); });
          resolve(keys.join(','));
        },
        (error) => resolve(`error ${error.message}`),
        { onlyOnce: true },
      ));
    }
    return out;
  },
};
