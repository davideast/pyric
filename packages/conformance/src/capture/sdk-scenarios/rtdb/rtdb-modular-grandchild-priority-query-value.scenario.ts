import type { RtdbScenario } from '../scenario-types.ts';

export const scenario: RtdbScenario = {
  observation: {
    name: 'rtdb-modular-grandchild-priority-query-value',
    rowIds: ['rtdb-modular#grandchild-priority-query-value'],
    description: 'A reader holds value listeners on two refs and three orderByKey queries while a second client changes only the priority of a grandchild, then its value. Records the value event count per listener after each write and the last snapshot. Captured on the dedicated RTDB oracle instance.',
  },
  async run(ctx) {
    const { rtdb, base, wait } = ctx;
    const writer = await ctx.newClient('writer');
    const reader = await ctx.newClient('reader');
    const w = (path: string) => rtdb.ref(writer.db, `${base}/${path}`);
    const r = (path: string) => rtdb.ref(reader.db, `${base}/${path}`);
    await rtdb.set(w('t'), { items: { a: { n: 7 } }, z: 1 });
    const seen: Record<string, string[]> = {};
    const targets = {
      'ref t': r('t'),
      'ref t/items': r('t/items'),
      't orderByKey limitToFirst(2)': rtdb.query(r('t'), rtdb.orderByKey(), rtdb.limitToFirst(2)),
      't orderByKey startAt(b)': rtdb.query(r('t'), rtdb.orderByKey(), rtdb.startAt('b')),
      't/items orderByKey limitToFirst(2)': rtdb.query(r('t/items'), rtdb.orderByKey(), rtdb.limitToFirst(2)),
    };
    const firsts = Object.entries(targets).map(([name, target]) => {
      seen[name] = [];
      return new Promise<void>((resolve) => {
        rtdb.onValue(target, (s) => { seen[name]!.push(JSON.stringify(s.exportVal())); resolve(); });
      });
    });
    await Promise.all(firsts);
    await wait(1000);
    const counts = () => Object.fromEntries(Object.entries(seen).map(([name, values]) => [name, values.length]));
    await rtdb.setPriority(w('t/items/a/n'), 'a');
    await wait(2000);
    const afterPriority = counts();
    await rtdb.set(w('t/items/a/n'), 8);
    await wait(2000);
    const afterControl = counts();
    const lastSnapshots = Object.fromEntries(Object.entries(seen).map(([name, values]) => [name, values.at(-1)]));
    return { afterPriority, afterControl, lastSnapshots };
  },
};
