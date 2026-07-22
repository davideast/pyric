import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  endAt,
  endBefore,
  equalTo,
  getDatabase,
  limitToFirst,
  limitToLast,
  orderByChild,
  orderByKey,
  orderByPriority,
  orderByValue,
  query,
  ref,
  serverTimestamp,
  startAfter,
  startAt,
  type QueryConstraint,
} from '../../../src/database/index.js';
import { load } from './oracle-conformance.support.js';

const observation = load('rtdb-modular-query-construction-validation.json');

function invocation(task: () => unknown): Record<string, unknown> {
  try {
    task();
    return { timing: 'resolved', value: 'accepted' };
  } catch (error) {
    return {
      timing: 'synchronous-throw',
      name: error instanceof Error ? error.name : typeof error,
      code: (error as { code?: unknown }).code ?? null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function rootRef() {
  return ref(getDatabase(initializeSandbox().withAuth({ uid: 'alice' })));
}

describe('query construction validation (oracle: rtdb-modular-query-construction-validation)', () => {
  it('validates both limit factories while preserving the captured Infinity quirk', () => {
    expect(() => limitToFirst(0)).toThrow('limitToFirst: First argument must be a positive integer.');
    expect(() => limitToFirst(1.5)).toThrow('limitToFirst: First argument must be a positive integer.');
    expect(() => limitToLast(-1)).toThrow('limitToLast: First argument must be a positive integer.');
    expect(() => limitToLast(Number.NaN)).toThrow('limitToLast: First argument must be a positive integer.');
    expect(() => limitToFirst(Number.POSITIVE_INFINITY)).not.toThrow();
    expect(() => limitToLast(Number.POSITIVE_INFINITY)).not.toThrow();
  });

  it('rejects reserved and invalid orderByChild paths at the captured phase', () => {
    expect(() => orderByChild('$key')).toThrow('orderByChild: "$key" is invalid.  Use orderByKey() instead.');
    expect(() => orderByChild('a.b')).toThrow(/orderByChild failed: path argument was an invalid path/);
    expect(() => query(rootRef(), orderByChild('/'))).toThrow(
      'orderByChild: cannot pass in empty path. Use orderByValue() instead.',
    );
    expect(() => query(rootRef(), orderByChild('a/b'))).not.toThrow();
  });

  it('validates cursor keys in each endpoint factory', () => {
    for (const factory of [startAt, startAfter, endAt, equalTo]) {
      expect(() => factory('value', 'bad/key')).toThrow(/key argument was an invalid key/);
      expect(() => factory('value', 'valid')).not.toThrow();
    }
  });

  it('applies orderByKey endpoint restrictions independent of constraint order', () => {
    const root = rootRef();
    const message = 'Query: When ordering by key, the argument passed to startAt(), startAfter(), endAt(), endBefore(), or equalTo() must be a string.';
    expect(() => query(root, orderByKey(), startAt(1))).toThrow(message);
    expect(() => query(root, startAt(1), orderByKey())).toThrow(message);
    expect(() => query(root, orderByKey(), startAt('a', 'b'))).toThrow(
      'Query: When ordering by key, you may only pass one argument to startAt(), endAt(), or equalTo().',
    );
  });

  it('preserves undefined and index-specific endpoint behavior', () => {
    const root = rootRef();
    expect(() => query(root, startAt(undefined as never))).not.toThrow();
    expect(() => query(root, startAfter(undefined as never))).toThrow(
      'startAfter failed: value argument contains undefined ',
    );
    expect(() => query(root, orderByValue(), startAt({ value: 1 } as never))).toThrow(
      'Query: First argument passed to startAt(), startAfter(), endAt(), endBefore(), or equalTo() cannot be an object.',
    );
    expect(() => query(root, orderByPriority(), startAt(serverTimestamp() as never))).not.toThrow();
  });

  it('replays every captured validation family exactly', () => {
    const root = rootRef();
    const endpoints: Record<string, (value?: unknown, key?: string) => QueryConstraint> = {
      startAt: startAt as never,
      startAfter: startAfter as never,
      endAt: endAt as never,
      endBefore: endBefore as never,
      equalTo: equalTo as never,
    };
    const accepted = (task: () => unknown): Record<string, unknown> => invocation(task);
    const limits = {
      limitToFirst: {
        one: accepted(() => limitToFirst(1)),
        positiveInfinity: accepted(() => limitToFirst(Number.POSITIVE_INFINITY)),
        zero: invocation(() => limitToFirst(0)),
        negative: invocation(() => limitToFirst(-1)),
        fractional: invocation(() => limitToFirst(1.5)),
        nan: invocation(() => limitToFirst(Number.NaN)),
        negativeInfinity: invocation(() => limitToFirst(Number.NEGATIVE_INFINITY)),
        nonNumber: invocation(() => limitToFirst('1' as never)),
      },
      limitToLast: {
        one: accepted(() => limitToLast(1)),
        positiveInfinity: accepted(() => limitToLast(Number.POSITIVE_INFINITY)),
        zero: invocation(() => limitToLast(0)),
        negative: invocation(() => limitToLast(-1)),
        fractional: invocation(() => limitToLast(1.5)),
        nan: invocation(() => limitToLast(Number.NaN)),
        negativeInfinity: invocation(() => limitToLast(Number.NEGATIVE_INFINITY)),
        nonNumber: invocation(() => limitToLast('1' as never)),
      },
    };
    expect(limits).toEqual(observation.limits);

    const orderByChildShape = {
      reserved: {
        key: invocation(() => orderByChild('$key')),
        priority: invocation(() => orderByChild('$priority')),
        value: invocation(() => orderByChild('$value')),
      },
      invalid: {
        empty: invocation(() => orderByChild('')),
        nonString: invocation(() => orderByChild(1 as never)),
        dot: invocation(() => orderByChild('a.b')),
        hash: invocation(() => orderByChild('a#b')),
        dollar: invocation(() => orderByChild('a$b')),
        openBracket: invocation(() => orderByChild('a[b')),
        closeBracket: invocation(() => orderByChild('a]b')),
        control: invocation(() => orderByChild('a\u0000b')),
        rootSlash: invocation(() => query(root, orderByChild('/'))),
      },
      accepted: {
        nested: accepted(() => query(root, orderByChild('a/b'))),
        ordinary: accepted(() => query(root, orderByChild('value'))),
      },
    };
    expect(orderByChildShape).toEqual(observation.orderByChild);

    const eachEndpoint: Record<string, unknown> = {};
    for (const [name, factory] of Object.entries(endpoints)) {
      eachEndpoint[name] = {
        invalidKey: invocation(() => factory('value', 'bad/key')),
        acceptedOmitted: accepted(() => factory('value')),
        acceptedValid: accepted(() => factory('value', 'a')),
      };
    }
    const invalidStartAtKeys: Record<string, unknown> = {};
    for (const [name, key] of Object.entries({
      empty: '', nonString: 2, dot: '.', hash: '#', dollar: '$', slash: '/',
      openBracket: '[', closeBracket: ']', control: '\u0000',
    })) invalidStartAtKeys[name] = invocation(() => startAt('value', key as never));
    expect({ eachEndpoint, invalidStartAtKeys }).toEqual(observation.cursorKeys);

    const keyEndpointShape: Record<string, unknown> = {};
    for (const [name, factory] of Object.entries(endpoints)) {
      keyEndpointShape[name] = {
        nonString: invocation(() => query(root, orderByKey(), factory(1))),
        secondKey: invocation(() => query(root, orderByKey(), factory('a', 'b'))),
        accepted: accepted(() => query(root, orderByKey(), factory('a'))),
      };
    }
    expect({
      eachEndpoint: keyEndpointShape,
      nullValue: invocation(() => query(root, orderByKey(), startAt(null))),
      boolean: invocation(() => query(root, orderByKey(), startAt(false))),
      object: invocation(() => query(root, orderByKey(), startAt({ value: 1 } as never))),
      reversedOrder: invocation(() => query(root, startAt(1), orderByKey())),
    }).toEqual(observation.orderByKeyEndpoints);

    expect({
      startAt: accepted(() => query(root, startAt(undefined as never))),
      endAt: accepted(() => query(root, endAt(undefined as never))),
      startAfter: invocation(() => query(root, startAfter(undefined as never))),
      endBefore: invocation(() => query(root, endBefore(undefined as never))),
      equalTo: invocation(() => query(root, equalTo(undefined as never))),
    }).toEqual(observation.undefinedEndpoints);

    const valueValidation: Record<string, unknown> = {};
    for (const [name, factory] of Object.entries(endpoints)) {
      valueValidation[name] = {
        nan: invocation(() => query(root, orderByValue(), factory(Number.NaN))),
        positiveInfinity: invocation(() =>
          query(root, orderByValue(), factory(Number.POSITIVE_INFINITY))),
        negativeInfinity: invocation(() =>
          query(root, orderByValue(), factory(Number.NEGATIVE_INFINITY))),
        invalidNestedKey: invocation(() =>
          query(root, orderByValue(), factory({ 'bad.key': true }))),
      };
    }
    expect(valueValidation).toEqual(observation.valueValidation);

    const orderByValueAccepted: Record<string, unknown> = {};
    for (const [name, value] of Object.entries({
      boolean: false, nullValue: null, string: 'value', number: 1,
    })) orderByValueAccepted[name] = accepted(() => query(root, orderByValue(), startAt(value)));
    expect({
      defaultPriority: {
        serverTimestamp: accepted(() => query(root, startAt(serverTimestamp() as never))),
        boolean: invocation(() => query(root, startAt(false))),
        object: invocation(() => query(root, startAt({ value: 1 } as never))),
      },
      explicitPriority: {
        serverTimestamp: accepted(() =>
          query(root, orderByPriority(), startAt(serverTimestamp() as never))),
        boolean: invocation(() => query(root, orderByPriority(), startAt(false))),
        object: invocation(() =>
          query(root, orderByPriority(), startAt({ value: 1 } as never))),
      },
      orderByChildObject: invocation(() =>
        query(root, orderByChild('value'), startAt({ value: 1 } as never))),
      orderByValueObject: invocation(() =>
        query(root, orderByValue(), startAt({ value: 1 } as never))),
      orderByValueAccepted,
    }).toEqual(observation.byIndex);
  });
});
