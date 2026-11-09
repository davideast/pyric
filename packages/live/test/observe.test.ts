import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'bun:test';
import { firestoreListener } from '../src/firestore.js';
import { MAX_MESSAGE_LENGTH, noMessage, observedCall, observedListener, type LiveCallRecord, type LiveListenerJournal, type LiveObserver, type ObservedSite } from '../src/observe.js';
import { sessionDataOf } from '../src/session-data.js';

const OBSERVE_URL = new URL('../src/observe.ts', import.meta.url).href;

/**
 * Runs, in a Node process of its own, an app that calls a wrapped `getDoc`
 * whose promise rejects and never handles it. `setup` runs first. Bun's test
 * runner fails a test on any unhandled rejection, so the runtime's own
 * behavior is checked in Node. Node 22 strips types from `observe.ts` only
 * behind `--experimental-strip-types`; Node 24 accepts the flag as well.
 * The source imports its siblings as `.js`, as the built files do, so a
 * resolve hook finds the `.ts` file beside a `.js` specifier Node cannot.
 */
function rejectInNode(setup: string): { status: number | null; stdout: string; stderr: string } {
  const app = [
    "import { registerHooks } from 'node:module';",
    "registerHooks({ resolve(specifier, context, next) { try { return next(specifier, context); } catch (error) { if (!specifier.endsWith('.js')) throw error; return next(`${specifier.slice(0, -3)}.ts`, context); } } });",
    setup,
    `const { observedCall } = await import(${JSON.stringify(OBSERVE_URL)});`,
    `const getDoc = observedCall({ module: 'firebase/firestore', name: 'getDoc', observer: () => undefined }, () => Promise.reject(Object.assign(new Error('permission-denied'), { code: 'permission-denied' })));`,
    'getDoc();',
  ].join('\n');
  const run = spawnSync('node', ['--experimental-strip-types', '--no-warnings', '--input-type=module', '--eval', app], { encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

function collector(): { records: LiveCallRecord[]; observer: LiveObserver } {
  const records: LiveCallRecord[] = [];
  return { records, observer: (record) => records.push(record) };
}

const failingObservers: Record<string, LiveObserver> = {
  'throws': () => {
    throw new Error('recorder down');
  },
  'rejects': async () => {
    throw new Error('recorder down');
  },
};

class CodedError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a one-shot wrapper', () => {
  test("records the project of the app its first argument belongs to, and nothing else of the argument's", () => {
    const { records, observer } = collector();
    const app = { options: { projectId: 'prod', apiKey: 'key' } };
    const wrapped = observedCall({ module: 'firebase/firestore', name: 'getDoc', observer }, () => undefined);
    wrapped({ firestore: { app }, path: 'rooms/r1' });
    wrapped({ app });
    wrapped(app);
    wrapped({ path: 'no-app' });
    wrapped();
    const hostile = new Proxy({}, { get: () => { throw new Error('no reads'); } });
    wrapped(hostile);
    expect(records.map((record) => record.projectId)).toEqual(['prod', 'prod', 'prod', undefined, undefined, undefined]);
    expect(records[0]).toEqual({ module: 'firebase/firestore', name: 'getDoc', outcome: 'returned', projectId: 'prod' });
  });

  test("a listener's deliveries name the project its target's app names", () => {
    const { records, observer } = collector();
    let deliver: (value: unknown) => void = () => undefined;
    const listen = observedListener({ module: 'firebase/firestore', name: 'onSnapshot', observer }, (_target: unknown, next: unknown) => {
      deliver = next as (value: unknown) => void;
      return () => undefined;
    });
    listen({ firestore: { app: { options: { projectId: 'prod' } } } }, () => undefined);
    deliver({});
    expect(records.map((record) => [record.outcome, record.projectId])).toEqual([['returned', 'prod'], ['delivered', 'prod']]);
  });

  test('returns the real result and records the return', () => {
    const { records, observer } = collector();
    const result = { value: 1 };
    const wrapped = observedCall({ module: 'firebase/firestore', name: 'doc', observer }, () => result);
    expect(wrapped()).toBe(result);
    expect(records).toEqual([{ module: 'firebase/firestore', name: 'doc', outcome: 'returned' }]);
  });

  test('passes the arguments and this through unchanged', () => {
    const { observer } = collector();
    const seen: unknown[] = [];
    const wrapped = observedCall({ module: 'm', name: 'n', observer }, function (this: unknown, ...args: unknown[]) {
      seen.push(this, ...args);
    });
    const self = {};
    const arg = { a: 1 };
    wrapped.call(self, arg, 2);
    expect(seen[0]).toBe(self);
    expect(seen[1]).toBe(arg);
    expect(seen[2]).toBe(2);
  });

  test('returns a promise that resolves with the real value, and records the resolution first', async () => {
    const { records, observer } = collector();
    const snapshot = { value: 'snapshot' };
    const wrapped = observedCall({ module: 'firebase/firestore', name: 'getDoc', observer }, () => Promise.resolve(snapshot));
    expect(await wrapped()).toBe(snapshot);
    expect(records.map((record) => record.outcome)).toEqual(['resolved']);
  });

  test('returns a promise that rejects with the real reason, and records the rejection with its code first', async () => {
    const { records, observer } = collector();
    const error = new CodedError('permission-denied');
    const wrapped = observedCall({ module: 'firebase/firestore', name: 'getDoc', observer }, () => Promise.reject(error));
    const returned = wrapped() as Promise<unknown>;
    expect(await returned.catch((reason: unknown) => reason)).toBe(error);
    expect(records).toEqual([{ module: 'firebase/firestore', name: 'getDoc', outcome: 'rejected', code: 'permission-denied', message: 'permission-denied' }]);
  });

  test('a rejection the app never handles still reaches Node\'s unhandledRejection event', () => {
    const run = rejectInNode(`process.on('unhandledRejection', (reason) => console.log('unhandled', reason.code));`);
    expect(run.stdout.trim()).toBe('unhandled permission-denied');
    expect(run.status).toBe(0);
  });

  test('a rejection the app never handles still ends a Node process, as it does without live mode', () => {
    const run = rejectInNode('');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('permission-denied');
  });

  test('throws the real error and records it', () => {
    const { records, observer } = collector();
    const error = new TypeError('bad path');
    const wrapped = observedCall({ module: 'firebase/firestore', name: 'doc', observer }, () => {
      throw error;
    });
    expect(() => wrapped()).toThrow(error);
    expect(records).toEqual([{ module: 'firebase/firestore', name: 'doc', outcome: 'threw', code: 'TypeError', message: 'bad path' }]);
  });

  test('records no argument and no result', async () => {
    const { records, observer } = collector();
    const wrapped = observedCall({ module: 'firebase/auth', name: 'getIdToken', observer }, async () => 'secret-token');
    await wrapped('secret-argument');
    expect(JSON.stringify(records)).not.toContain('secret');
  });
});

describe('a one-shot wrapper whose observer measures', () => {
  /** Measures as the senders' `measureObservedUsage` does for these four calls: counts read off the resolved value. */
  function measure(module: string, method: string, value: unknown): Record<string, number> | undefined {
    const answer = value as { docs?: unknown[]; val?: () => unknown; metadata?: { size?: number }; byteLength?: number };
    if (method === 'getDocs') return { documentReads: answer.docs?.length ?? 0 };
    if (method === 'get') return { payloadBytes: JSON.stringify(answer.val?.()).length };
    if (method === 'uploadBytes' || method === 'uploadBytesResumable') return { uploadedBytes: answer.metadata?.size ?? 0 };
    if (method === 'getBytes') return { downloadedBytes: answer.byteLength ?? 0 };
    return module === 'firebase/auth' ? undefined : { unmeasured: 1 };
  }

  const CALLS: readonly [string, string, unknown, Record<string, number>][] = [
    ['firebase/firestore', 'getDocs', { docs: [{ secret: 1 }, { secret: 2 }, { secret: 3 }] }, { documentReads: 3 }],
    ['firebase/database', 'get', { val: () => ({ secret: 'value' }) }, { payloadBytes: 18 }],
    ['firebase/storage', 'uploadBytes', { metadata: { size: 42, name: 'secret.png' } }, { uploadedBytes: 42 }],
    ['firebase/storage', 'getBytes', new ArrayBuffer(7), { downloadedBytes: 7 }],
  ];

  for (const [module, name, value, usage] of CALLS) {
    test(`a resolved ${name} carries the usage the observer measured, and no value`, async () => {
      const { records, observer } = collector();
      const measuring = Object.assign(observer, { measure });
      const wrapped = observedCall({ module, name, observer: measuring }, () => Promise.resolve(value));
      expect(await wrapped('secret-argument')).toBe(value);
      expect(records).toEqual([{ module, name, outcome: 'resolved', usage }]);
      expect(JSON.stringify(records)).not.toContain('secret');
    });

    test(`a resolved ${name} carries no usage when the observer does not measure`, async () => {
      const { records, observer } = collector();
      const wrapped = observedCall({ module, name, observer }, () => Promise.resolve(value));
      await wrapped();
      expect(records).toEqual([{ module, name, outcome: 'resolved' }]);
    });
  }

  test('an uploadBytesResumable task is measured by the snapshot it settles with, not the task', async () => {
    const { records, observer } = collector();
    const snapshot = { metadata: { size: 9 } };
    const task = { then: (resolve: (value: unknown) => void) => resolve(snapshot) };
    const site = { module: 'firebase/storage', name: 'uploadBytesResumable', observer: Object.assign(observer, { measure }), followsThenable: true };
    const wrapped = observedCall(site, () => task);
    expect(await (wrapped() as Promise<unknown>)).toBe(snapshot);
    expect(records).toEqual([{ module: 'firebase/storage', name: 'uploadBytesResumable', outcome: 'resolved', usage: { uploadedBytes: 9 } }]);
  });

  test('a rejection and a measure that throws carry no usage, and the app still gets its answer', async () => {
    const thrown = collector();
    const rejected = collector();
    const throwing = Object.assign(thrown.observer, { measure: () => { throw new Error('measure down'); } });
    const read = observedCall({ module: 'firebase/firestore', name: 'getDocs', observer: throwing }, () => Promise.resolve({ docs: [] }));
    const denied = observedCall({ module: 'firebase/firestore', name: 'getDocs', observer: Object.assign(rejected.observer, { measure }) }, () => Promise.reject(new CodedError('permission-denied')));
    expect(await read()).toEqual({ docs: [] });
    expect(await (denied() as Promise<unknown>).catch((error: CodedError) => error.code)).toBe('permission-denied');
    expect(thrown.records).toEqual([{ module: 'firebase/firestore', name: 'getDocs', outcome: 'resolved' }]);
    expect(rejected.records).toEqual([{ module: 'firebase/firestore', name: 'getDocs', outcome: 'rejected', code: 'permission-denied', message: 'permission-denied' }]);
  });
});

describe("a failure's record carries production's message", () => {
  async function rejectedWith(error: unknown, hooks: Partial<ObservedSite> = {}): Promise<LiveCallRecord> {
    const { records, observer } = collector();
    const wrapped = observedCall({ module: 'firebase/firestore', name: 'getDoc', observer, ...hooks }, () => Promise.reject(error));
    await (wrapped() as Promise<unknown>).catch(() => undefined);
    return records[0]!;
  }

  test("the SDK error's message, trimmed", async () => {
    const error = Object.assign(new Error(' Missing or insufficient permissions. '), { code: 'permission-denied' });
    expect((await rejectedWith(error)).message).toBe('Missing or insufficient permissions.');
  });

  test('an email address in it stays intact, and a long one is cut to the length a host takes', async () => {
    const withEmail = Object.assign(new Error("User does not have permission to access 'users/ada@example.com/a.png'."), { code: 'storage/unauthorized' });
    expect((await rejectedWith(withEmail)).message).toBe("User does not have permission to access 'users/ada@example.com/a.png'.");
    const long = Object.assign(new Error('x'.repeat(MAX_MESSAGE_LENGTH + 50)), { code: 'internal' });
    expect((await rejectedWith(long)).message).toHaveLength(MAX_MESSAGE_LENGTH);
  });

  test('none for an error with no message, one that throws on read, or a module that keeps none', async () => {
    expect(await rejectedWith({ code: 'internal' })).not.toHaveProperty('message');
    const throwing = { code: 'internal', get message(): string { throw new Error('unreadable'); } };
    expect(await rejectedWith(throwing)).toMatchObject({ outcome: 'rejected', code: 'internal' });
    expect(await rejectedWith(throwing)).not.toHaveProperty('message');
    const quoted = Object.assign(new Error('Messaging: token-subscribe-failed dGVzdA:APA91b'), { code: 'messaging/token-subscribe-failed' });
    expect(await rejectedWith(quoted, { messageOf: noMessage })).not.toHaveProperty('message');
  });
});

describe('a recorder failure never changes what the app sees', () => {
  for (const [label, observer] of Object.entries(failingObservers)) {
    test(`an observer that ${label}: results, rejections and throws pass through`, async () => {
      const value = { value: 1 };
      expect(observedCall({ module: 'm', name: 'n', observer }, () => value)()).toBe(value);
      const resolved = observedCall({ module: 'm', name: 'n', observer }, () => Promise.resolve(value))() as Promise<unknown>;
      expect(await resolved).toBe(value);
      const error = new CodedError('unavailable');
      const returned = observedCall({ module: 'm', name: 'n', observer }, () => Promise.reject(error))() as Promise<unknown>;
      expect(await returned.catch((reason: unknown) => reason)).toBe(error);
      const thrower = observedCall({ module: 'm', name: 'n', observer }, () => {
        throw error;
      });
      expect(() => thrower()).toThrow(error);
      await tick();
    });

    test(`an observer that ${label}: listener values and errors still reach the app`, () => {
      const delivered: unknown[] = [];
      const subscribe = observedListener({ module: 'm', name: 'onSnapshot', observer }, (_target: unknown, next: unknown, error: unknown) => {
        (next as (value: unknown) => void)('snapshot');
        (error as (reason: unknown) => void)(new CodedError('permission-denied'));
        return 'unsubscribe';
      });
      const result = subscribe('target', (value: unknown) => delivered.push(value), (reason: unknown) => delivered.push(reason));
      expect(result).toBe('unsubscribe');
      expect(delivered[0]).toBe('snapshot');
      expect(delivered[1]).toBeInstanceOf(CodedError);
    });
  }

  test('an error whose code cannot be read is still thrown to the app unchanged', () => {
    const { records, observer } = collector();
    const error = new Error('odd');
    Object.defineProperty(error, 'code', {
      get() {
        throw new Error('getter down');
      },
    });
    const wrapped = observedCall({ module: 'm', name: 'n', observer }, () => {
      throw error;
    });
    expect(() => wrapped()).toThrow(error);
    expect(records).toEqual([]);
  });

  test('an async observer that rejects leaves no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      observedCall({ module: 'm', name: 'n', observer: failingObservers.rejects! }, () => 1)();
      await tick();
      await tick();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

describe('a listener wrapper', () => {
  test('records the subscribe call, each delivery and each listener error', () => {
    const { records, observer } = collector();
    const subscribe = observedListener({ module: 'firebase/firestore', name: 'onSnapshot', observer }, (_target: unknown, _options: unknown, next: unknown, error: unknown) => {
      (next as (value: unknown) => void)('first');
      (error as (reason: unknown) => void)(new CodedError('permission-denied'));
      return () => undefined;
    });
    const delivered: unknown[] = [];
    subscribe('ref', { includeMetadataChanges: true }, (value: unknown) => delivered.push(value), (reason: unknown) => delivered.push(reason));
    expect(delivered[0]).toBe('first');
    expect(records.map((record) => [record.outcome, record.code])).toEqual([
      ['delivered', undefined],
      ['listener-error', 'permission-denied'],
      ['returned', undefined],
    ]);
  });

  test('passes options through and calls an observer object as itself', () => {
    const { records, observer } = collector();
    const options = { includeMetadataChanges: true };
    let seenOptions: unknown;
    const subscribe = observedListener({ module: 'firebase/auth', name: 'onAuthStateChanged', observer }, (_target: unknown, givenOptions: unknown, listener: unknown) => {
      seenOptions = givenOptions;
      const partial = listener as { next: (value: unknown) => void; error: (reason: unknown) => void };
      partial.next('user');
      partial.error(new CodedError('auth/network-request-failed'));
    });
    const appObserver = {
      seen: [] as unknown[],
      next(value: unknown) {
        this.seen.push(value);
      },
      error(reason: unknown) {
        this.seen.push(reason);
      },
    };
    subscribe('auth', options, appObserver);
    expect(seenOptions).toBe(options);
    expect(appObserver.seen[0]).toBe('user');
    expect(records.map((record) => record.outcome)).toEqual(['delivered', 'listener-error', 'returned']);
  });

  test('lets an error thrown by the app callback reach the SDK unchanged', () => {
    const { observer } = collector();
    const thrown = new Error('app bug');
    let caught: unknown;
    const subscribe = observedListener({ module: 'm', name: 'onSnapshot', observer }, (next: unknown) => {
      try {
        (next as (value: unknown) => void)('value');
      } catch (error) {
        caught = error;
      }
    });
    subscribe(() => {
      throw thrown;
    });
    expect(caught).toBe(thrown);
  });

  test('with an error callback, records the error, hands it to the app and does nothing else', () => {
    const { records, observer } = collector();
    const uncaught: unknown[] = [];
    const error = new CodedError('permission-denied');
    const subscribe = observedListener(
      { module: 'firebase/firestore', name: 'onSnapshot', observer, uncaughtListenerError: (reason) => uncaught.push(reason) },
      (_target: unknown, _next: unknown, onError: unknown) => (onError as (reason: unknown) => void)(error),
    );
    const delivered: unknown[] = [];
    subscribe('ref', () => undefined, (reason: unknown) => delivered.push(reason));
    expect(delivered).toEqual([error]);
    expect(uncaught).toEqual([]);
    expect(records.map((record) => [record.outcome, record.code])).toEqual([['listener-error', 'permission-denied'], ['returned', undefined]]);
  });

  for (const [label, passed] of [['an omitted', []], ['an undefined', [undefined]], ['a null', [null]]] as const) {
    test(`with ${label} error callback, records the error, then does what the SDK does without one`, () => {
      const { records, observer } = collector();
      const uncaught: unknown[] = [];
      const error = new CodedError('permission-denied');
      const seenArgs: unknown[][] = [];
      const subscribe = observedListener(
        { module: 'firebase/firestore', name: 'onSnapshot', observer, uncaughtListenerError: (reason) => uncaught.push(reason) },
        (...args: unknown[]) => {
          seenArgs.push(args);
          (args[3] as (reason: unknown) => void)(error);
        },
      );
      subscribe('ref', { includeMetadataChanges: true }, () => undefined, ...passed);
      expect(seenArgs[0]![1]).toEqual({ includeMetadataChanges: true });
      expect(uncaught).toEqual([error]);
      expect(records.map((record) => [record.outcome, record.code])).toEqual([['listener-error', 'permission-denied'], ['returned', undefined]]);
    });
  }

  test('with no error callback and an SDK that drops such errors, records the error and does nothing else', () => {
    const { records, observer } = collector();
    const subscribe = observedListener({ module: 'firebase/app-check', name: 'onTokenChanged', observer }, (_target: unknown, _next: unknown, onError: unknown) => {
      expect(() => (onError as (reason: unknown) => void)(new CodedError('appCheck/fetch-status-error'))).not.toThrow();
    });
    subscribe('app-check', () => undefined);
    expect(records.map((record) => [record.outcome, record.code])).toEqual([['listener-error', 'appCheck/fetch-status-error'], ['returned', undefined]]);
  });

  test('an observer object with no error method gets one that records, then does what the SDK does without one', () => {
    const { records, observer } = collector();
    const uncaught: unknown[] = [];
    const error = new CodedError('permission-denied');
    const subscribe = observedListener(
      { module: 'firebase/firestore', name: 'onSnapshot', observer, uncaughtListenerError: (reason) => uncaught.push(reason) },
      (_target: unknown, listener: unknown) => (listener as { error: (reason: unknown) => void }).error(error),
    );
    subscribe('ref', { next: () => undefined });
    expect(uncaught).toEqual([error]);
    expect(records.map((record) => record.outcome)).toEqual(['listener-error', 'returned']);
  });

  test('a failure while doing what the SDK does without an error callback never reaches the SDK', () => {
    const { records, observer } = collector();
    const subscribe = observedListener(
      {
        module: 'firebase/firestore',
        name: 'onSnapshot',
        observer,
        uncaughtListenerError: () => {
          throw new Error('log down');
        },
      },
      (_target: unknown, _next: unknown, onError: unknown) => {
        expect(() => (onError as (reason: unknown) => void)(new CodedError('unavailable'))).not.toThrow();
      },
    );
    subscribe('ref', () => undefined);
    expect(records.map((record) => record.outcome)).toEqual(['listener-error', 'returned']);
  });
});

/** A query snapshot as the SDK hands one to a listener: its changes, and the metadata the SDK raised it for. */
function querySnapshot(changes: number, hasPendingWrites: boolean): unknown {
  return { docChanges: () => Array.from({ length: changes }, () => ({ type: 'added' })), metadata: { hasPendingWrites, fromCache: false } };
}

/** A document snapshot as the SDK hands one to a listener. */
function documentSnapshot(data: Record<string, unknown> | undefined, hasPendingWrites: boolean): unknown {
  return { exists: () => data !== undefined, data: () => data, metadata: { hasPendingWrites, fromCache: false } };
}

describe('the documents a Firestore listener delivery was billed for', () => {
  test('a query listener with includeMetadataChanges: each changed document, at least one first, none for a metadata-only delivery', () => {
    const { records, observer } = collector();
    const subscribe = observedListener({ module: 'firebase/firestore', name: 'onSnapshot', observer }, (_target: unknown, _options: unknown, next: unknown) => {
      const deliver = next as (value: unknown) => void;
      deliver(querySnapshot(0, false));
      deliver(querySnapshot(2, true));
      deliver(querySnapshot(0, false));
      deliver(querySnapshot(1, false));
      return () => undefined;
    });
    subscribe('query', { includeMetadataChanges: true }, () => undefined);
    const delivered = records.filter((record) => record.outcome === 'delivered');
    expect(delivered.map((record) => record.billedDocuments)).toEqual([1, 2, 0, 1]);
  });

  test('a document listener with includeMetadataChanges: one per change of the document, none when only its metadata changed', () => {
    const { records, observer } = collector();
    const subscribe = observedListener({ module: 'firebase/firestore', name: 'onSnapshot', observer }, (_target: unknown, _options: unknown, next: unknown) => {
      const deliver = next as (value: unknown) => void;
      deliver(documentSnapshot(undefined, false));
      deliver(documentSnapshot({ title: 'a', tags: ['x'] }, true));
      deliver(documentSnapshot({ title: 'a', tags: ['x'] }, false));
      deliver(documentSnapshot({ title: 'b', tags: ['x'] }, false));
      deliver(documentSnapshot(undefined, false));
      return () => undefined;
    });
    subscribe('ref', { includeMetadataChanges: true }, () => undefined);
    const delivered = records.filter((record) => record.outcome === 'delivered');
    expect(delivered.map((record) => record.billedDocuments)).toEqual([1, 1, 0, 1, 1]);
  });

  test('two listeners keep their own count, and a delivery that is not a snapshot carries none', () => {
    const { records, observer } = collector();
    const delivers: ((value: unknown) => void)[] = [];
    const subscribe = observedListener({ module: 'firebase/firestore', name: 'onSnapshot', observer }, (_target: unknown, next: unknown) => {
      delivers.push(next as (value: unknown) => void);
      return () => undefined;
    });
    subscribe('ref-a', () => undefined);
    subscribe('ref-b', () => undefined);
    delivers[0]?.(documentSnapshot({ n: 1 }, false));
    delivers[1]?.(documentSnapshot({ n: 1 }, false));
    delivers[0]?.('not a snapshot');
    const delivered = records.filter((record) => record.outcome === 'delivered');
    expect(delivered.map((record) => record.billedDocuments)).toEqual([1, 1, undefined]);
  });
});

/** An observer that journals listeners, keeping each journal step and app call in `steps`. */
function journaling(steps: unknown[][], failing = false): LiveObserver {
  const journal: LiveListenerJournal = (subject) => {
    if (failing) throw new Error('journal down');
    steps.push(['open', subject.method, subject.target, subject.isQuery]);
    return {
      deliver(value, billedDocuments, run) {
        steps.push(['deliver', billedDocuments]);
        return run();
      },
      fail: () => steps.push(['fail']),
      close: () => steps.push(['close']),
    };
  };
  return Object.assign(() => undefined, { journal });
}

const firestore = { app: { options: { projectId: 'demo' } } };
const roomsQuery = { type: 'query', firestore, _query: { path: { canonicalString: () => 'rooms' }, filters: [{ op: '==' }] } };

describe('a listener wrapper whose observer journals listeners', () => {
  test('opens a Firestore listener, reports each delivery just before the app callback, and closes it on unsubscribe', () => {
    const steps: unknown[][] = [];
    let deliver: (value: unknown) => void = () => undefined;
    const subscribe = observedListener({ module: 'firebase/firestore', name: 'onSnapshot', observer: journaling(steps) }, (_target: unknown, next: unknown) => {
      deliver = next as (value: unknown) => void;
      return () => steps.push(['sdk unsubscribe']);
    });
    const snapshot = querySnapshot(1, false);
    const unsubscribe = subscribe(roomsQuery, (value: unknown) => steps.push(['app', value === snapshot])) as () => void;
    deliver(snapshot);
    unsubscribe();
    expect(steps).toEqual([['open', 'onSnapshot', 'rooms', true], ['deliver', 1], ['app', true], ['close'], ['sdk unsubscribe']]);
  });

  test('names a document listener by its path, and journals its error before the app gets it', () => {
    const steps: unknown[][] = [];
    const subscribe = observedListener({ module: 'firebase/firestore', name: 'onSnapshot', observer: journaling(steps) }, (_target: unknown, _next: unknown, error: unknown) => {
      (error as (reason: unknown) => void)(new CodedError('permission-denied'));
      return () => undefined;
    });
    subscribe({ type: 'document', firestore, path: 'rooms/lobby' }, () => undefined, (reason: unknown) => steps.push(['app', reason instanceof CodedError]));
    expect(steps).toEqual([['open', 'onSnapshot', 'rooms/lobby', false], ['fail'], ['app', true]]);
  });

  test('journals nothing for a listener on anything but a Firestore reference or query, and returns the SDK unsubscribe itself', () => {
    const steps: unknown[][] = [];
    const sdkUnsubscribe = () => undefined;
    const subscribe = observedListener({ module: 'firebase/auth', name: 'onAuthStateChanged', observer: journaling(steps) }, () => sdkUnsubscribe);
    expect(subscribe({ app: firestore.app }, () => undefined)).toBe(sdkUnsubscribe);
    expect(steps).toEqual([]);
  });

  test('a journal that fails leaves the app callback, its value and the SDK unsubscribe as they were', () => {
    const delivered: unknown[] = [];
    const sdkUnsubscribe = () => undefined;
    const subscribe = observedListener({ module: 'firebase/firestore', name: 'onSnapshot', observer: journaling([], true) }, (_target: unknown, next: unknown) => {
      (next as (value: unknown) => void)('snapshot');
      return sdkUnsubscribe;
    });
    expect(subscribe(roomsQuery, (value: unknown) => delivered.push(value))).toBe(sdkUnsubscribe);
    expect(delivered).toEqual(['snapshot']);
  });

  test('an error the app callback throws reaches the SDK unchanged, and the callback runs once', () => {
    const thrown = new Error('app bug');
    let calls = 0;
    let caught: unknown;
    const subscribe = observedListener({ module: 'firebase/firestore', name: 'onSnapshot', observer: journaling([]) }, (_target: unknown, next: unknown) => {
      try {
        (next as (value: unknown) => void)('value');
      } catch (error) {
        caught = error;
      }
      return () => undefined;
    });
    subscribe(roomsQuery, () => {
      calls += 1;
      throw thrown;
    });
    expect(caught).toBe(thrown);
    expect(calls).toBe(1);
  });
});

/** A listener id this realm mints. */
const LISTENER_ID = /^l-[0-9a-f]{8}-[0-9]+$/;
/** A key's keyed hash. */
const KEY_HASH = /^[0-9a-f]{16}$/;

/** A stand-in listener export: it hands the test its callbacks and returns an unsubscribe that counts its calls. */
function standInListener(): { real: (...args: unknown[]) => unknown; next: () => (value: unknown) => void; error: () => (reason: unknown) => void; unsubscribes: () => number } {
  let handed: unknown[] = [];
  let unsubscribes = 0;
  return {
    real: (...args: unknown[]) => {
      handed = args;
      return () => {
        unsubscribes += 1;
      };
    },
    next: () => handed.find((arg) => typeof arg === 'function') as (value: unknown) => void,
    error: () => handed.filter((arg) => typeof arg === 'function')[1] as (reason: unknown) => void,
    unsubscribes: () => unsubscribes,
  };
}

/** The lifecycle records, as `[outcome, id, key]`. */
function lifecycleOf(records: readonly LiveCallRecord[]): unknown[][] {
  return records.filter((record) => record.listener !== undefined).map((record) => [record.outcome, record.listener?.id, record.listener?.key]);
}

describe('a listener whose module names what it watches', () => {
  const lobby = { type: 'document', firestore, path: 'rooms/lobby' };

  test('records attached at subscribe, in place of returned, and detached once at unsubscribe, sharing one id', () => {
    const { records, observer } = collector();
    const sdk = standInListener();
    const subscribe = observedListener({ module: 'firebase/firestore', name: 'onSnapshot', observer, listenerOf: firestoreListener }, sdk.real);
    const unsubscribe = subscribe(lobby, () => undefined) as () => void;
    sdk.next()('snapshot');
    unsubscribe();
    unsubscribe();
    expect(records.map((record) => record.outcome)).toEqual(['attached', 'delivered', 'detached']);
    const [attached, delivered, detached] = records;
    expect(attached?.listener?.id).toMatch(LISTENER_ID);
    expect(attached?.listener?.key).toMatch(KEY_HASH);
    expect(detached?.listener).toEqual(attached?.listener);
    expect(delivered).not.toHaveProperty('listener');
    expect(delivered?.listenerId).toBe(attached?.listener?.id);
    expect(attached).toMatchObject({ path: 'rooms/lobby', projectId: 'demo' });
    expect(sdk.unsubscribes()).toBe(2);
  });

  test('emits attached before delivered even when the SDK invokes the callback synchronously inside subscribe', () => {
    const { records, observer } = collector();
    const subscribe = observedListener(
      { module: 'firebase/firestore', name: 'onSnapshot', observer, listenerOf: firestoreListener },
      (_target: unknown, next: unknown) => {
        (next as (value: unknown) => void)('cached-snapshot');
        return () => undefined;
      },
    );
    const unsubscribe = subscribe(lobby, () => undefined) as () => void;
    unsubscribe();
    expect(records.map((record) => record.outcome)).toEqual(['attached', 'delivered', 'detached']);
    expect(records[1]?.listenerId).toBe(records[0]?.listener?.id);
  });

  test('gives each subscription its own id, and two on one document one hashed key that holds no path', () => {
    const { records, observer } = collector();
    const subscribe = observedListener({ module: 'firebase/firestore', name: 'onSnapshot', observer, listenerOf: firestoreListener }, standInListener().real);
    subscribe(lobby, () => undefined);
    subscribe({ ...lobby }, () => undefined);
    subscribe({ type: 'document', firestore, path: 'rooms/hall' }, () => undefined);
    const [first, second, hall] = lifecycleOf(records);
    expect(new Set([first![1], second![1], hall![1]]).size).toBe(3);
    expect(second![2]).toBe(first![2]);
    expect(hall![2]).not.toBe(first![2]);
    expect(JSON.stringify(records.map((record) => record.listener))).not.toContain('rooms');
  });

  test("an error ends the listener: the error, then detached, and the app's later unsubscribe records nothing", () => {
    for (const appError of [(_reason: unknown) => undefined, undefined]) {
      const { records, observer } = collector();
      const sdk = standInListener();
      const subscribe = observedListener({ module: 'firebase/firestore', name: 'onSnapshot', observer, listenerOf: firestoreListener }, sdk.real);
      const unsubscribe = subscribe(lobby, () => undefined, appError) as () => void;
      sdk.error()(new CodedError('permission-denied'));
      unsubscribe();
      expect(records.map((record) => [record.outcome, record.code])).toEqual([
        ['attached', undefined],
        ['listener-error', 'permission-denied'],
        ['detached', undefined],
      ]);
    }
  });

  test('a subscribe the SDK throws on records the throw and no lifecycle', () => {
    const { records, observer } = collector();
    const subscribe = observedListener({ module: 'firebase/firestore', name: 'onSnapshot', observer, listenerOf: firestoreListener }, () => {
      throw new CodedError('invalid-argument');
    });
    expect(() => subscribe(lobby, () => undefined)).toThrow('invalid-argument');
    expect(records.map((record) => record.outcome)).toEqual(['threw']);
  });

  test('a target the hook cannot name, or a hook that throws, keeps the plain returned record', () => {
    const { records, observer } = collector();
    const named = observedListener({ module: 'firebase/firestore', name: 'onSnapshot', observer, listenerOf: firestoreListener }, standInListener().real);
    named({ type: 'unknown' }, () => undefined);
    const throwing = observedListener({ module: 'm', name: 'onSnapshot', observer, listenerOf: () => { throw new Error('hook down'); } }, standInListener().real);
    throwing(lobby, () => undefined);
    expect(records.map((record) => [record.outcome, record.listener])).toEqual([['returned', undefined], ['returned', undefined]]);
  });

  test("hands the module a detach for the subscription, which records detached once and forgets it", () => {
    const { records, observer } = collector();
    const detaches: Array<() => void> = [];
    let forgotten = 0;
    const listenerAttached = (_name: string, _args: readonly unknown[], detach: () => void) => {
      detaches.push(detach);
      return () => { forgotten += 1; };
    };
    const subscribe = observedListener({ module: 'firebase/database', name: 'onValue', observer, listenerOf: () => ({ target: '/items', key: 'items' }), listenerAttached }, standInListener().real);
    const unsubscribe = subscribe({}, () => undefined) as () => void;
    detaches[0]!();
    detaches[0]!();
    unsubscribe();
    expect(records.map((record) => record.outcome)).toEqual(['attached', 'detached']);
    expect(forgotten).toBe(1);
  });

  test('an onSnapshotResume of a document snapshot listens to that document; of a query snapshot, to nothing it can name', () => {
    const { records, observer } = collector();
    const resume = observedListener({ module: 'firebase/firestore', name: 'onSnapshotResume', observer, listenerOf: firestoreListener }, standInListener().real);
    const unsubscribe = resume(firestore, { bundleSource: 'DocumentSnapshot', bundleName: 'rooms/lobby', bundle: '' }, () => undefined) as () => void;
    unsubscribe();
    resume(firestore, { bundleSource: 'QuerySnapshot', bundleName: 'AbC123', bundle: '' }, () => undefined);
    expect(records.map((record) => record.outcome)).toEqual(['attached', 'detached', 'returned']);
    const resumed = lifecycleOf(records)[0]!;
    const direct = collector();
    const subscribe = observedListener({ module: 'firebase/firestore', name: 'onSnapshot', observer: direct.observer, listenerOf: firestoreListener }, standInListener().real);
    subscribe(lobby, () => undefined);
    expect(lifecycleOf(direct.records)[0]![2]).toBe(resumed[2]);
  });

  test('attaches non-enumerable sessionData on resolved and delivered Admin calls without putting values on records', async () => {
    const { records, observer } = collector();
    const resolvedDelta = { firestore: [{ kind: 'set' as const, path: 'items/i1', data: { secret: 'admin-doc' } }] };
    const deliveredDelta = { rtdb: [{ kind: 'set' as const, instance: 'demo-default-rtdb', path: '/items/i1', value: 'admin-rtdb' }] };
    const adminRead = observedCall(
      {
        module: '@google-cloud/firestore',
        name: 'DocumentReference.get',
        sdk: 'admin',
        observer,
        resultOf: () => ({ sessionData: resolvedDelta }),
      },
      async () => ({ ok: true }),
    );
    await adminRead();

    const adminFail = observedCall(
      {
        module: '@google-cloud/firestore',
        name: 'DocumentReference.set',
        sdk: 'admin',
        observer,
        context: () => ({ sessionData: resolvedDelta }),
      },
      async () => {
        throw new CodedError('unavailable');
      },
    );
    await (adminFail() as Promise<unknown>).catch(() => undefined);

    const sdk = standInListener();
    const adminListen = observedListener(
      {
        module: '@firebase/database-compat/standalone',
        name: 'Query.on',
        sdk: 'admin',
        observer,
        deliveryOf: () => deliveredDelta,
      },
      sdk.real,
    );
    adminListen('ref', () => undefined);
    sdk.next()({ val: () => 'admin-rtdb' });

    expect(sessionDataOf(records[0]!)).toEqual(resolvedDelta);
    expect(sessionDataOf(records[1]!)).toBeUndefined();
    expect(sessionDataOf(records.find((r) => r.outcome === 'delivered')!)).toEqual(deliveredDelta);
    expect(JSON.stringify(records)).not.toContain('admin-doc');
    expect(JSON.stringify(records)).not.toContain('admin-rtdb');
  });

  test('keeps onCallStart lease active across async and thenable settlement and releases before terminal reporting', async () => {
    const { records, observer } = collector();
    const events: string[] = [];
    let active = false;

    let resolveAsync!: (value: string) => void;
    const asyncWrite = observedCall(
      {
        module: 'firebase/database',
        name: 'set',
        observer: (record) => {
          events.push(`observer:${record.outcome}:active=${String(active)}`);
          observer(record);
        },
        context: () => ({
          onCallStart: () => {
            active = true;
            events.push('start');
            return {
              onReturn(returned) {
                events.push(`onReturn:${typeof returned}`);
              },
              release() {
                active = false;
                events.push('release');
              },
            };
          },
        }),
      },
      () => {
        events.push(`inside:active=${String(active)}`);
        return new Promise<string>((resolve) => {
          resolveAsync = resolve;
        });
      },
    );

    const pending = asyncWrite() as Promise<unknown>;
    // Lease MUST remain active after synchronous return while the Promise is still pending (M5).
    expect(active).toBe(true);
    expect(events).toEqual(['start', 'inside:active=true', 'onReturn:object']);

    resolveAsync('done');
    await pending;
    expect(active).toBe(false);
    expect(events).toEqual([
      'start',
      'inside:active=true',
      'onReturn:object',
      'release',
      'observer:resolved:active=false',
    ]);
    expect(records).toHaveLength(1);

    // Synchronous throw releases the lease immediately.
    let syncThrowActive = false;
    const syncThrowCall = observedCall(
      {
        module: 'firebase/database',
        name: 'set',
        observer,
        context: () => ({
          onCallStart: () => {
            syncThrowActive = true;
            return {
              onReturn() {},
              release() {
                syncThrowActive = false;
              },
            };
          },
        }),
      },
      () => {
        expect(syncThrowActive).toBe(true);
        throw new CodedError('invalid-argument');
      },
    );
    expect(() => syncThrowCall()).toThrow('invalid-argument');
    expect(syncThrowActive).toBe(false);
  });
});
