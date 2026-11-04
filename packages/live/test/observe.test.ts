import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'bun:test';
import { observedCall, observedListener, type LiveCallRecord, type LiveObserver } from '../src/observe.js';

const OBSERVE_URL = new URL('../src/observe.ts', import.meta.url).href;

/**
 * Runs, in a Node process of its own, an app that calls a wrapped `getDoc`
 * whose promise rejects and never handles it. `setup` runs first. Bun's test
 * runner fails a test on any unhandled rejection, so the runtime's own
 * behavior is checked in Node. Node 22 strips types from `observe.ts` only
 * behind `--experimental-strip-types`; Node 24 accepts the flag as well.
 */
function rejectInNode(setup: string): { status: number | null; stdout: string; stderr: string } {
  const app = [
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
    expect(records).toEqual([{ module: 'firebase/firestore', name: 'getDoc', outcome: 'rejected', code: 'permission-denied' }]);
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
    expect(records).toEqual([{ module: 'firebase/firestore', name: 'doc', outcome: 'threw', code: 'TypeError' }]);
  });

  test('records no argument and no result', async () => {
    const { records, observer } = collector();
    const wrapped = observedCall({ module: 'firebase/auth', name: 'getIdToken', observer }, async () => 'secret-token');
    await wrapped('secret-argument');
    expect(JSON.stringify(records)).not.toContain('secret');
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
