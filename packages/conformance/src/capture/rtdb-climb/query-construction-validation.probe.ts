import { createHash } from 'node:crypto';
import {
  type QueryConstraint,
  child,
  endAt,
  endBefore,
  equalTo,
  limitToFirst,
  limitToLast,
  orderByChild,
  orderByKey,
  orderByPriority,
  orderByValue,
  query,
  ref,
  serverTimestamp,
  set,
  startAfter,
  startAt,
  update,
} from 'firebase/database';
import {
  adminRead,
  adminRemove,
  captureInvocation,
  cleanup,
  createClient,
  repeatStable,
  scenarioPath,
  stable,
} from './probe-runtime.ts';
import type { RtdbClimbContext, RtdbClimbProbe } from './probe-types.ts';

export function createProbe(ctx: RtdbClimbContext): RtdbClimbProbe {
  return {
      name: 'rtdb-modular-query-construction-validation',
      matrixRow: 'rtdb-modular#M94',
      rowIds: ['rtdb-modular#M94'],
      description:
        'Synchronous query-constraint validation for limits, child paths, cursor keys and index-specific endpoint values, with accepted-construction and successful online-write controls.',
      observe: () => repeatStable(2, async (attempt) => {
        const path = scenarioPath(ctx, 'query-construction-validation', attempt);
        const client = await createClient(ctx, `query-construction-validation-${attempt}`);
        try {
          const root = ref(client.db);
          const target = ref(client.db, path);
          await set(target, { control: true });
          const accepted = (task: () => unknown): Promise<Record<string, unknown>> =>
            captureInvocation(() => { task(); return 'accepted'; });
          const endpoints: Record<string, (value?: unknown, key?: string) => QueryConstraint> = {
            startAt: startAt as never,
            startAfter: startAfter as never,
            endAt: endAt as never,
            endBefore: endBefore as never,
            equalTo: equalTo as never,
          };
          const endpointEntries = Object.entries(endpoints);
          const eachEndpoint = async (
            task: (factory: (value?: unknown, key?: string) => QueryConstraint) => unknown,
          ): Promise<Record<string, unknown>> => Object.fromEntries(await Promise.all(
            endpointEntries.map(async ([name, factory]) => [name, await captureInvocation(() => task(factory))]),
          ));

          const invalidStartAtKeys: Record<string, unknown> = {};
          for (const [name, key] of Object.entries({
            empty: '',
            nonString: 2,
            dot: '.',
            hash: '#',
            dollar: '$',
            slash: '/',
            openBracket: '[',
            closeBracket: ']',
            control: '\u0000',
          })) {
            invalidStartAtKeys[name] = await captureInvocation(() => startAt('value', key as never));
          }

          const keyEndpoints: Record<string, unknown> = {};
          for (const [name, factory] of endpointEntries) {
            keyEndpoints[name] = {
              invalidKey: await captureInvocation(() => factory('value', 'bad/key')),
              acceptedOmitted: await accepted(() => factory('value')),
              acceptedValid: await accepted(() => factory('value', 'a')),
            };
          }

          const orderByKeyEndpoints: Record<string, unknown> = {};
          for (const [name, factory] of endpointEntries) {
            orderByKeyEndpoints[name] = {
              nonString: await captureInvocation(() => query(root, orderByKey(), factory(1))),
              secondKey: await captureInvocation(() => query(root, orderByKey(), factory('a', 'b'))),
              accepted: await accepted(() => query(root, orderByKey(), factory('a'))),
            };
          }

          const valueValidation: Record<string, unknown> = {};
          for (const [name, factory] of endpointEntries) {
            valueValidation[name] = {
              nan: await captureInvocation(() => query(root, orderByValue(), factory(Number.NaN))),
              positiveInfinity: await captureInvocation(() =>
                query(root, orderByValue(), factory(Number.POSITIVE_INFINITY))),
              negativeInfinity: await captureInvocation(() =>
                query(root, orderByValue(), factory(Number.NEGATIVE_INFINITY))),
              invalidNestedKey: await captureInvocation(() =>
                query(root, orderByValue(), factory({ 'bad.key': true }))),
            };
          }

          const byValueAccepted: Record<string, unknown> = {};
          for (const [name, value] of Object.entries({
            boolean: false,
            nullValue: null,
            string: 'value',
            number: 1,
          })) {
            byValueAccepted[name] = await accepted(() => query(root, orderByValue(), startAt(value)));
          }

          const contract = {
            limits: {
              limitToFirst: {
                one: await accepted(() => limitToFirst(1)),
                positiveInfinity: await accepted(() => limitToFirst(Number.POSITIVE_INFINITY)),
                zero: await captureInvocation(() => limitToFirst(0)),
                negative: await captureInvocation(() => limitToFirst(-1)),
                fractional: await captureInvocation(() => limitToFirst(1.5)),
                nan: await captureInvocation(() => limitToFirst(Number.NaN)),
                negativeInfinity: await captureInvocation(() => limitToFirst(Number.NEGATIVE_INFINITY)),
                nonNumber: await captureInvocation(() => limitToFirst('1' as never)),
              },
              limitToLast: {
                one: await accepted(() => limitToLast(1)),
                positiveInfinity: await accepted(() => limitToLast(Number.POSITIVE_INFINITY)),
                zero: await captureInvocation(() => limitToLast(0)),
                negative: await captureInvocation(() => limitToLast(-1)),
                fractional: await captureInvocation(() => limitToLast(1.5)),
                nan: await captureInvocation(() => limitToLast(Number.NaN)),
                negativeInfinity: await captureInvocation(() => limitToLast(Number.NEGATIVE_INFINITY)),
                nonNumber: await captureInvocation(() => limitToLast('1' as never)),
              },
            },
            orderByChild: {
              reserved: {
                key: await captureInvocation(() => orderByChild('$key')),
                priority: await captureInvocation(() => orderByChild('$priority')),
                value: await captureInvocation(() => orderByChild('$value')),
              },
              invalid: {
                empty: await captureInvocation(() => orderByChild('')),
                nonString: await captureInvocation(() => orderByChild(1 as never)),
                dot: await captureInvocation(() => orderByChild('a.b')),
                hash: await captureInvocation(() => orderByChild('a#b')),
                dollar: await captureInvocation(() => orderByChild('a$b')),
                openBracket: await captureInvocation(() => orderByChild('a[b')),
                closeBracket: await captureInvocation(() => orderByChild('a]b')),
                control: await captureInvocation(() => orderByChild('a\u0000b')),
                rootSlash: await captureInvocation(() => query(root, orderByChild('/'))),
              },
              accepted: {
                nested: await accepted(() => query(root, orderByChild('a/b'))),
                ordinary: await accepted(() => query(root, orderByChild('value'))),
              },
            },
            cursorKeys: {
              eachEndpoint: keyEndpoints,
              invalidStartAtKeys,
            },
            orderByKeyEndpoints: {
              eachEndpoint: orderByKeyEndpoints,
              nullValue: await captureInvocation(() => query(root, orderByKey(), startAt(null))),
              boolean: await captureInvocation(() => query(root, orderByKey(), startAt(false))),
              object: await captureInvocation(() =>
                query(root, orderByKey(), startAt({ value: 1 } as never))),
              reversedOrder: await captureInvocation(() => query(root, startAt(1), orderByKey())),
            },
            undefinedEndpoints: {
              startAt: await accepted(() => query(root, startAt(undefined))),
              endAt: await accepted(() => query(root, endAt(undefined as never))),
              startAfter: await captureInvocation(() => query(root, startAfter(undefined as never))),
              endBefore: await captureInvocation(() => query(root, endBefore(undefined as never))),
              equalTo: await captureInvocation(() => query(root, equalTo(undefined as never))),
            },
            valueValidation,
            byIndex: {
              defaultPriority: {
                serverTimestamp: await accepted(() =>
                  query(root, startAt(serverTimestamp() as never))),
                boolean: await captureInvocation(() => query(root, startAt(false))),
                object: await captureInvocation(() => query(root, startAt({ value: 1 } as never))),
              },
              explicitPriority: {
                serverTimestamp: await accepted(() =>
                  query(root, orderByPriority(), startAt(serverTimestamp() as never))),
                boolean: await captureInvocation(() => query(root, orderByPriority(), startAt(false))),
                object: await captureInvocation(() =>
                  query(root, orderByPriority(), startAt({ value: 1 } as never))),
              },
              orderByChildObject: await captureInvocation(() =>
                query(root, orderByChild('value'), startAt({ value: 1 } as never))),
              orderByValueObject: await captureInvocation(() =>
                query(root, orderByValue(), startAt({ value: 1 } as never))),
              orderByValueAccepted: byValueAccepted,
            },
          };
          return {
            ...contract,
            contractDigest: createHash('sha256').update(stable(contract)).digest('hex'),
            normalWriteControl: await adminRead(ctx, path),
          };
        } finally {
          await cleanup([() => client.close(), () => adminRemove(ctx, path)]);
        }
      }),
    };
}
