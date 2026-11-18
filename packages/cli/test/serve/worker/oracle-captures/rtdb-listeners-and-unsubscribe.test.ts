import { describe, expect, it } from 'bun:test';
import * as client from '../../../../src/serve/worker/index.js';
import {
  observeOffTargetedAndChildRegistrars,
  type OffTargetedAndChildRegistrarsSdk,
} from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-off-targeted-and-child-registrars.ts';
import {
  observeOnValueInitialDescendantAndSuppression,
  type OnValueSuppressionProbeSdk,
} from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-onvalue-initial-descendant-and-suppression.ts';
import {
  observeOnValueOnlyOnceAndUnsubReturn,
  type OnValueOnlyOnceAndUnsubSdk,
} from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-onvalue-onlyonce-and-unsub-return.ts';
import {
  observeQueryWindowChildListeners,
  type QueryWindowChildListenersSdk,
} from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-query-window-child-listeners.ts';
import {
  hostedRtdbContext,
  load,
  restoreSharedWorker,
  servedRtdbContext,
  type ServedRtdbAdminContext,
} from './support.ts';

restoreSharedWorker();

const LISTENERS_REPLAY_RULES: Record<string, unknown> = {
  rules: {
    '.read': 'auth != null',
    '.write': 'auth != null',
    pyric_oracle: {
      replay: {
        scores: {
          '.indexOn': ['score'],
        },
      },
    },
  },
};

type ServedPlaneFactory = () => Promise<ServedRtdbAdminContext>;

const PLANES: ReadonlyArray<[string, ServedPlaneFactory]> = [
  ['served SharedWorker', () => servedRtdbContext(LISTENERS_REPLAY_RULES)],
  ['served Node host', () => hostedRtdbContext(LISTENERS_REPLAY_RULES)],
];

async function signInPort(ctx: ServedRtdbAdminContext): Promise<void> {
  const port = (ctx.db as unknown as { port: client.ClientDb['port'] }).port;
  await client.signInAnonymously(client.getAuth({ port } as never));
}

for (const [planeLabel, createContext] of PLANES) {
  describe(`RTDB modular listeners, off(), onlyOnce, and query-window child events oracle captures (${planeLabel})`, () => {
    it('rtdb-modular-onvalue-initial-descendant-and-suppression (rtdb-modular#M26..#M29)', async () => {
      const ctx = await createContext();
      await signInPort(ctx);
      const actual = await observeOnValueInitialDescendantAndSuppression(
        {
          db: ctx.db as unknown as OnValueSuppressionProbeSdk['db'],
          ref: ctx.rtdb.ref as unknown as OnValueSuppressionProbeSdk['ref'],
          child: ctx.rtdb.child as unknown as OnValueSuppressionProbeSdk['child'],
          set: ctx.rtdb.set as unknown as OnValueSuppressionProbeSdk['set'],
          update: ctx.rtdb.update as unknown as OnValueSuppressionProbeSdk['update'],
          onValue: ctx.rtdb.onValue as unknown as OnValueSuppressionProbeSdk['onValue'],
        },
        ctx.base,
      );
      expect(actual as unknown).toEqual(
        load('rtdb-modular-onvalue-initial-descendant-and-suppression'),
      );
    });

    it('rtdb-modular-onvalue-onlyonce-and-unsub-return (rtdb-modular#M30, #M74, #132)', async () => {
      const ctx = await createContext();
      await signInPort(ctx);
      const actual = await observeOnValueOnlyOnceAndUnsubReturn(
        {
          db: ctx.db as unknown as OnValueOnlyOnceAndUnsubSdk['db'],
          ref: ctx.rtdb.ref as unknown as OnValueOnlyOnceAndUnsubSdk['ref'],
          set: ctx.rtdb.set as unknown as OnValueOnlyOnceAndUnsubSdk['set'],
          onValue: ctx.rtdb.onValue as unknown as OnValueOnlyOnceAndUnsubSdk['onValue'],
        },
        ctx.base,
      );
      expect(actual as unknown).toEqual(load('rtdb-modular-onvalue-onlyonce-and-unsub-return'));
    });

    it('rtdb-modular-off-targeted-and-child-registrars (rtdb-modular#M31, #M44, #M48, #140)', async () => {
      const ctx = await createContext();
      await signInPort(ctx);
      const actual = await observeOffTargetedAndChildRegistrars(
        {
          db: ctx.db as unknown as OffTargetedAndChildRegistrarsSdk['db'],
          ref: ctx.rtdb.ref as unknown as OffTargetedAndChildRegistrarsSdk['ref'],
          child: ctx.rtdb.child as unknown as OffTargetedAndChildRegistrarsSdk['child'],
          setWithPriority:
            ctx.rtdb.setWithPriority as unknown as OffTargetedAndChildRegistrarsSdk['setWithPriority'],
          setPriority:
            ctx.rtdb.setPriority as unknown as OffTargetedAndChildRegistrarsSdk['setPriority'],
          remove: ctx.rtdb.remove as unknown as OffTargetedAndChildRegistrarsSdk['remove'],
          onValue: ctx.rtdb.onValue as unknown as OffTargetedAndChildRegistrarsSdk['onValue'],
          onChildAdded:
            ctx.rtdb.onChildAdded as unknown as OffTargetedAndChildRegistrarsSdk['onChildAdded'],
          onChildChanged:
            ctx.rtdb.onChildChanged as unknown as OffTargetedAndChildRegistrarsSdk['onChildChanged'],
          onChildRemoved:
            ctx.rtdb.onChildRemoved as unknown as OffTargetedAndChildRegistrarsSdk['onChildRemoved'],
          onChildMoved:
            ctx.rtdb.onChildMoved as unknown as OffTargetedAndChildRegistrarsSdk['onChildMoved'],
          off: ctx.rtdb.off as unknown as OffTargetedAndChildRegistrarsSdk['off'],
        },
        ctx.base,
      );
      expect(actual.childRegistrarIsolation.initialAdded).toEqual([
        { key: 'a', val: { v: 1 }, prevKey: null },
        { key: 'b', val: { v: 2 }, prevKey: 'a' },
      ]);
      expect(actual as unknown).toEqual(load('rtdb-modular-off-targeted-and-child-registrars'));
    });

    it('rtdb-modular-query-window-child-listeners (rtdb-modular#M75b)', async () => {
      const ctx = await createContext();
      await signInPort(ctx);
      const actual = await observeQueryWindowChildListeners(
        {
          db: ctx.db as unknown as QueryWindowChildListenersSdk['db'],
          ref: ctx.rtdb.ref as unknown as QueryWindowChildListenersSdk['ref'],
          child: ctx.rtdb.child as unknown as QueryWindowChildListenersSdk['child'],
          set: ctx.rtdb.set as unknown as QueryWindowChildListenersSdk['set'],
          query: ctx.rtdb.query as unknown as QueryWindowChildListenersSdk['query'],
          orderByChild:
            ctx.rtdb.orderByChild as unknown as QueryWindowChildListenersSdk['orderByChild'],
          limitToFirst:
            ctx.rtdb.limitToFirst as unknown as QueryWindowChildListenersSdk['limitToFirst'],
          onValue: ctx.rtdb.onValue as unknown as QueryWindowChildListenersSdk['onValue'],
          onChildAdded:
            ctx.rtdb.onChildAdded as unknown as QueryWindowChildListenersSdk['onChildAdded'],
          onChildChanged:
            ctx.rtdb.onChildChanged as unknown as QueryWindowChildListenersSdk['onChildChanged'],
          onChildRemoved:
            ctx.rtdb.onChildRemoved as unknown as QueryWindowChildListenersSdk['onChildRemoved'],
          onChildMoved:
            ctx.rtdb.onChildMoved as unknown as QueryWindowChildListenersSdk['onChildMoved'],
        },
        ctx.base,
      );
      expect(actual as unknown).toEqual(load('rtdb-modular-query-window-child-listeners'));
    });
  });
}
