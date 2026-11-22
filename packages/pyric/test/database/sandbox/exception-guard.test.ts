/**
 * Regression suite for #1933: throwing RTDB listener callbacks must match
 * `@firebase/database`'s `exceptionGuard` semantics: isolate sibling
 * deliveries synchronously, record sandbox `'errored'` telemetry, log the
 * Firebase warning with stack, and rethrow asynchronously via `setTimeout`.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  goOffline,
  goOnline,
  onChildAdded,
  onChildChanged,
  onChildMoved,
  onChildRemoved,
  onValue,
  orderByChild,
  query,
  ref,
  remove,
  sandbox as rtdbSandbox,
  set,
  setWithPriority,
  update,
} from '../../../src/database/index.js';

function openDb() {
  const sb = initializeSandbox();
  const db = getDatabase(sb);
  rtdbSandbox.setRules(db, { rules: { '.read': true, '.write': true } });
  return { sb, db };
}

interface CapturedRethrows {
  readonly scheduled: Array<() => void>;
  readonly warnCalls: unknown[][];
  restore(): void;
}

function captureExceptionGuardRethrows(): CapturedRethrows {
  const scheduled: Array<() => void> = [];
  const warnCalls: unknown[][] = [];
  const realSetTimeout = globalThis.setTimeout;
  const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
    ((fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (fn.name === 'rtdbExceptionGuardRethrow') {
        scheduled.push(() => fn(...args));
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(fn, delay, ...args);
    }) as typeof setTimeout,
  );
  const warnSpy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnCalls.push(args);
  });
  return {
    scheduled,
    warnCalls,
    restore() {
      timeoutSpy.mockRestore();
      warnSpy.mockRestore();
    },
  };
}

function runAndCatch(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected scheduled callback to rethrow');
}

describe('RTDB listener exceptionGuard parity (#1933)', () => {
  it('rethrows onValue throws (initial, write, query, onlyOnce) without blocking siblings or telemetry', async () => {
    const { sb, db } = openDb();
    const erroredMessages: string[] = [];
    sb.onEvent((event) => {
      if (event.service === 'rtdb' && event.kind === 'listener' && event.phase === 'errored') {
        erroredMessages.push(String(event.error?.message ?? ''));
      }
    });

    await set(ref(db, 'items'), { a: { score: 1 }, b: { score: 2 } });

    const capture = captureExceptionGuardRethrows();
    try {
      const siblingValues: unknown[] = [];
      const plainError = new Error('plain-value-boom');
      const queryError = new Error('query-value-boom');
      const onceError = new Error('once-value-boom');

      let plainCalls = 0;
      const stopPlain = onValue(ref(db, 'items/a/score'), () => {
        plainCalls += 1;
        throw plainError;
      });
      const stopSibling = onValue(ref(db, 'items/a/score'), (snap) => {
        siblingValues.push(snap.val());
      });

      const querySibling: unknown[] = [];
      const stopQuery = onValue(query(ref(db, 'items'), orderByChild('score')), () => {
        throw queryError;
      });
      const stopQuerySibling = onValue(query(ref(db, 'items'), orderByChild('score')), (snap) => {
        querySibling.push(snap.val());
      });

      onValue(ref(db, 'items/b/score'), () => {
        throw onceError;
      }, { onlyOnce: true });

      // Initial deliveries: plain (1) + query (1) + onlyOnce (1) = 3 scheduled rethrows.
      expect(plainCalls).toBe(1);
      expect(siblingValues).toEqual([1]);
      expect(querySibling).toHaveLength(1);
      expect(capture.scheduled).toHaveLength(3);

      // Subsequent write triggers plain + query again, NOT onlyOnce.
      await set(ref(db, 'items/a/score'), 5);
      await set(ref(db, 'items/b/score'), 9);
      expect(siblingValues).toEqual([1, 5]);
      expect(capture.scheduled).toHaveLength(6);

      stopPlain();
      stopSibling();
      stopQuery();
      stopQuerySibling();

      expect(runAndCatch(capture.scheduled[0] as () => void)).toBe(plainError);
      expect(runAndCatch(capture.scheduled[1] as () => void)).toBe(queryError);
      expect(runAndCatch(capture.scheduled[2] as () => void)).toBe(onceError);
      expect(capture.warnCalls).toHaveLength(3);
      for (const call of capture.warnCalls) {
        expect(String(call[1])).toContain('FIREBASE WARNING: Exception was thrown by user callback.');
      }
      expect(erroredMessages).toContain('plain-value-boom');
      expect(erroredMessages).toContain('query-value-boom');
      expect(erroredMessages).toContain('once-value-boom');
    } finally {
      capture.restore();
    }
  });

  it('rethrows onChildAdded, onChildChanged, onChildRemoved, and onChildMoved throws while isolating siblings', async () => {
    const { db } = openDb();
    const listRef = ref(db, 'list');
    await setWithPriority(ref(db, 'list/a'), { rank: 1 }, 1);

    const capture = captureExceptionGuardRethrows();
    try {
      const siblingEvents: string[] = [];
      const errors = {
        added: new Error('child-added-boom'),
        changed: new Error('child-changed-boom'),
        moved: new Error('child-moved-boom'),
        removed: new Error('child-removed-boom'),
      };

      const unsubs = [
        onChildAdded(listRef, () => { throw errors.added; }),
        onChildAdded(listRef, (snap) => { siblingEvents.push(`add:${snap.key}`); }),
        onChildChanged(listRef, () => { throw errors.changed; }),
        onChildChanged(listRef, (snap) => { siblingEvents.push(`chg:${snap.key}`); }),
        onChildMoved(listRef, () => { throw errors.moved; }),
        onChildMoved(listRef, (snap) => { siblingEvents.push(`mov:${snap.key}`); }),
        onChildRemoved(listRef, () => { throw errors.removed; }),
        onChildRemoved(listRef, (snap) => { siblingEvents.push(`rem:${snap.key}`); }),
      ];

      await setWithPriority(ref(db, 'list/b'), { rank: 2 }, 2);
      await setWithPriority(ref(db, 'list/b'), { rank: 3 }, 0);
      await remove(ref(db, 'list/a'));

      for (const unsub of unsubs) {
        unsub();
      }

      expect(siblingEvents).toEqual(['add:a', 'add:b', 'mov:b', 'chg:b', 'rem:a']);
      // add:a, add:b, mov:b, chg:b, rem:a -> 5 throws.
      expect(capture.scheduled).toHaveLength(5);
      const thrown = capture.scheduled.map((fn) => runAndCatch(fn));
      expect(thrown).toEqual([
        errors.added,
        errors.added,
        errors.moved,
        errors.changed,
        errors.removed,
      ]);
    } finally {
      capture.restore();
    }
  });

  it('rethrows throws from /.info value and child listeners without blocking siblings', () => {
    const sb = initializeSandbox();
    const db = getDatabase(sb);

    const capture = captureExceptionGuardRethrows();
    try {
      const connectedLog: unknown[] = [];
      const childKeys: Array<string | null> = [];
      const infoValueError = new Error('info-value-boom');
      const infoChildError = new Error('info-child-boom');

      const stopA = onValue(ref(db, '.info/connected'), () => {
        throw infoValueError;
      });
      const stopB = onValue(ref(db, '.info/connected'), (snap) => {
        connectedLog.push(snap.val());
      });
      const stopC = onChildAdded(ref(db, '.info'), () => {
        throw infoChildError;
      });
      const stopD = onChildAdded(ref(db, '.info'), (snap) => {
        childKeys.push(snap.key);
      });

      goOffline(db);
      goOnline(db);

      stopA();
      stopB();
      stopC();
      stopD();

      expect(connectedLog).toEqual([true, false, true]);
      expect(childKeys).toContain('connected');
      // 3 value deliveries (true, false, true) + 2 initial .info children (connected, serverTimeOffset).
      expect(capture.scheduled).toHaveLength(5);
      expect(runAndCatch(capture.scheduled[0] as () => void)).toBe(infoValueError);
      expect(runAndCatch(capture.scheduled[1] as () => void)).toBe(infoChildError);
    } finally {
      capture.restore();
    }
  });

  it('rethrows throws from offline optimistic overlay and reconnect deliveries without blocking siblings', async () => {
    const { sb, db } = openDb();
    const otherDb = getDatabase(sb.withAuth({ uid: 'peer' }));
    const nodeRef = ref(db, 'offline-node');
    await set(nodeRef, { k: 1 });

    const capture = captureExceptionGuardRethrows();
    try {
      const siblingVals: unknown[] = [];
      const offlineErr = new Error('offline-overlay-boom');
      let shouldThrow = false;

      const stopThrower = onValue(nodeRef, () => {
        if (shouldThrow) {
          throw offlineErr;
        }
      });
      const stopSibling = onValue(nodeRef, (snap) => {
        siblingVals.push(snap.val());
      });

      goOffline(db);
      shouldThrow = true;

      const pendingWrite = update(nodeRef, { k: 2 });
      expect(siblingVals.at(-1)).toEqual({ k: 2 });
      expect(capture.scheduled).toHaveLength(1);

      // Concurrent server write while offline -> deferred until reconnect.
      await set(ref(otherDb, 'offline-node/peer'), 'ok');
      goOnline(db);
      await pendingWrite;

      stopThrower();
      stopSibling();

      expect(capture.scheduled.length).toBeGreaterThanOrEqual(1);
      expect(runAndCatch(capture.scheduled[0] as () => void)).toBe(offlineErr);
    } finally {
      capture.restore();
    }
  });

  it('safely logs and rethrows non-Error primitive values without throwing TypeError', async () => {
    const { db } = openDb();
    const capture = captureExceptionGuardRethrows();
    try {
      const stopStr = onValue(ref(db, 'prim-a'), () => {
        throw 'string-failure';
      });
      const stopNull = onValue(ref(db, 'prim-b'), () => {
        throw null;
      });
      stopStr();
      stopNull();

      expect(capture.scheduled).toHaveLength(2);
      expect(runAndCatch(capture.scheduled[0] as () => void)).toBe('string-failure');
      expect(runAndCatch(capture.scheduled[1] as () => void)).toBeNull();
      expect(capture.warnCalls).toHaveLength(2);
      expect(String(capture.warnCalls[0]?.[1])).toContain('FIREBASE WARNING: Exception was thrown by user callback.');
    } finally {
      capture.restore();
    }
  });

  it('surfaces real uncaught errors asynchronously in a live runtime subprocess', async () => {
    const sandboxUrl = new URL('../../../src/sandbox/index.ts', import.meta.url).href;
    const dbUrl = new URL('../../../src/database/index.ts', import.meta.url).href;

    const crashProc = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import { initializeSandbox } from ${JSON.stringify(sandboxUrl)};
         import { getDatabase, ref, onValue, sandbox as rtdbSandbox } from ${JSON.stringify(dbUrl)};
         const db = getDatabase(initializeSandbox());
         rtdbSandbox.setRules(db, { rules: { '.read': true, '.write': true } });
         onValue(ref(db, 'crash'), () => { throw new Error('uncaught-onValue-boom'); });`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const crashStderr = await new Response(crashProc.stderr).text();
    const crashCode = await crashProc.exited;
    expect(crashCode).not.toBe(0);
    expect(crashStderr).toContain('FIREBASE WARNING: Exception was thrown by user callback.');
    expect(crashStderr).toContain('uncaught-onValue-boom');

    const observedProc = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import { initializeSandbox } from ${JSON.stringify(sandboxUrl)};
         import { getDatabase, ref, set, onChildAdded, sandbox as rtdbSandbox } from ${JSON.stringify(dbUrl)};
         const uncaught = [];
         process.on('uncaughtException', (err) => {
           uncaught.push(err instanceof Error ? err.message : String(err));
         });
         const db = getDatabase(initializeSandbox());
         rtdbSandbox.setRules(db, { rules: { '.read': true, '.write': true } });
         await set(ref(db, 'items'), { a: 1 });
         const order = [];
         onChildAdded(ref(db, 'items'), () => {
           order.push('thrower');
           throw new Error('uncaught-child-boom');
         });
         onChildAdded(ref(db, 'items'), (snap) => {
           order.push('sibling:' + snap.key);
         });
         order.push('after-sync');
         await new Promise((resolve) => setTimeout(resolve, 25));
         console.log(JSON.stringify({ order, uncaught }));`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const observedStdout = await new Response(observedProc.stdout).text();
    const observedCode = await observedProc.exited;
    expect(observedCode).toBe(0);
    const parsed = JSON.parse(observedStdout.trim()) as { order: string[]; uncaught: string[] };
    expect(parsed.order).toEqual(['thrower', 'sibling:a', 'after-sync']);
    expect(parsed.uncaught).toEqual(['uncaught-child-boom']);
  });
});
