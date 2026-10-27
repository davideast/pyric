import type { RtdbScenario } from '../scenario-types.ts';

export const scenario: RtdbScenario = {
  observation: {
    name: 'rtdb-modular-remote-update-event-order',
    rowIds: [
      'rtdb-modular#remote-update-event-order',
      'rtdb-modular#priority-change-child-changed',
      'rtdb-modular#priority-change-child-moved',
      'rtdb-modular#val-key-order',
      'rtdb-modular#served-event-order',
    ],
    description: 'A reader holds value, child and query listeners on /r while a second client runs one multi-path update and then setPriority on r/a. Records every event in arrival order, and the key order of val() for a ref and an orderByValue query. Captured on the dedicated RTDB oracle instance.',
  },
  // orderByValue on /r and /o needs an index in production; declare it so no warning path is taken.
  rules: {
    '.read': 'auth != null',
    '.write': 'auth != null',
    r: { '.indexOn': '.value' },
    o: { '.indexOn': '.value' },
  },
  async run(ctx) {
    const { rtdb, base, wait } = ctx;
    const writer = await ctx.newClient('writer');
    const reader = await ctx.newClient('reader');
    const w = (path: string) => rtdb.ref(writer.db, `${base}/${path}`);
    const r = (path: string) => rtdb.ref(reader.db, `${base}/${path}`);
    await rtdb.set(w('r'), { a: { x: 1 }, b: 2, c: 3 });
    await rtdb.set(w('o'), { b: 1, a: 3, c: 2 });
    const log: string[] = [];
    const once = (target: Parameters<typeof rtdb.onValue>[0]) =>
      new Promise<void>((resolve) => rtdb.onValue(target, () => resolve(), { onlyOnce: true }));
    rtdb.onValue(r('r'), () => log.push('R value'));
    rtdb.onChildAdded(r('r'), (s) => log.push(`R added ${s.key}`));
    rtdb.onChildChanged(r('r'), (s) => log.push(`R changed ${s.key}`));
    rtdb.onChildRemoved(r('r'), (s) => log.push(`R removed ${s.key}`));
    rtdb.onValue(r('r/a'), () => log.push('A value'));
    rtdb.onChildChanged(r('r/a'), (s) => log.push(`A changed ${s.key}`));
    const byValue = rtdb.query(r('r'), rtdb.orderByValue());
    rtdb.onChildChanged(byValue, (s) => log.push(`Q changed ${s.key}`));
    rtdb.onChildMoved(byValue, (s) => log.push(`Q moved ${s.key}`));
    const limited = rtdb.query(r('r'), rtdb.limitToFirst(3));
    rtdb.onChildMoved(limited, (s) => log.push(`L moved ${s.key}`));
    await Promise.all([once(r('r')), once(byValue), once(limited)]);
    await wait(1000);
    log.length = 0;
    log.push('-- update');
    await rtdb.update(w('r'), { 'a/x': 5, c: null, d: 4, b: 9 });
    await wait(1500);
    log.push('-- setPriority a 9');
    await rtdb.setPriority(w('r/a'), 9);
    await wait(1500);
    const valKeys: Record<string, string> = {};
    await new Promise<void>((resolve) => rtdb.onValue(r('o'), (s) => {
      valKeys.ref = Object.keys(s.val() as object).join(',');
      resolve();
    }, { onlyOnce: true }));
    await new Promise<void>((resolve) => rtdb.onValue(rtdb.query(r('o'), rtdb.orderByValue()), (s) => {
      valKeys.query = Object.keys(s.val() as object).join(',');
      resolve();
    }, { onlyOnce: true }));
    return { log, valKeys };
  },
};
