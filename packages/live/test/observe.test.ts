import { describe, expect, test } from 'bun:test';
import { observedCall, observedListener, type LiveCallRecord, type LiveObserver } from '../src/observe.js';

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

  test('returns the same promise and records its resolution', async () => {
    const { records, observer } = collector();
    const promise = Promise.resolve('snapshot');
    const wrapped = observedCall({ module: 'firebase/firestore', name: 'getDoc', observer }, () => promise);
    expect(wrapped()).toBe(promise);
    await tick();
    expect(records.map((record) => record.outcome)).toEqual(['resolved']);
  });

  test('returns the same rejected promise and records the rejection with its code', async () => {
    const { records, observer } = collector();
    const error = new CodedError('permission-denied');
    const promise = Promise.reject(error);
    const wrapped = observedCall({ module: 'firebase/firestore', name: 'getDoc', observer }, () => promise);
    const returned = wrapped() as Promise<unknown>;
    expect(returned).toBe(promise);
    expect(await returned.catch((reason: unknown) => reason)).toBe(error);
    expect(records).toEqual([{ module: 'firebase/firestore', name: 'getDoc', outcome: 'rejected', code: 'permission-denied' }]);
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
      const resolved = Promise.resolve(value);
      expect(observedCall({ module: 'm', name: 'n', observer }, () => resolved)()).toBe(resolved);
      const error = new CodedError('unavailable');
      const rejected = Promise.reject(error);
      const returned = observedCall({ module: 'm', name: 'n', observer }, () => rejected)() as Promise<unknown>;
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
});
