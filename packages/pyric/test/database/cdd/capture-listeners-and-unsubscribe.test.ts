import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth, signInAnonymously } from 'pyric/auth';
import * as pyricRtdb from 'pyric/database';
import {
  observeOffTargetedAndChildRegistrars,
  type OffTargetedAndChildRegistrarsSdk,
} from '../../../../conformance/probes/rtdb-modular/rtdb-modular-off-targeted-and-child-registrars.ts';
import {
  observeOnValueInitialDescendantAndSuppression,
  type OnValueSuppressionProbeSdk,
} from '../../../../conformance/probes/rtdb-modular/rtdb-modular-onvalue-initial-descendant-and-suppression.ts';
import {
  observeOnValueOnlyOnceAndUnsubReturn,
  type OnValueOnlyOnceAndUnsubSdk,
} from '../../../../conformance/probes/rtdb-modular/rtdb-modular-onvalue-onlyonce-and-unsub-return.ts';
import {
  observeQueryWindowChildListeners,
  type QueryWindowChildListenersSdk,
} from '../../../../conformance/probes/rtdb-modular/rtdb-modular-query-window-child-listeners.ts';
import { obs } from './capture-replay.ts';

async function withListenersSandbox<T>(
  run: (db: OnValueSuppressionProbeSdk['db'], sdk: typeof pyricRtdb) => Promise<T>,
): Promise<T> {
  const sandbox = initializeSandbox({ projectId: 'demo-rtdb-listeners-cdd' });
  await signInAnonymously(getAuth(sandbox));
  const rawDb = pyricRtdb.getDatabase(sandbox);
  pyricRtdb.sandbox.setRules(rawDb, {
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
  });
  try {
    return await run(rawDb as unknown as OnValueSuppressionProbeSdk['db'], pyricRtdb);
  } finally {
    sandbox.dispose();
  }
}

describe('RTDB modular listeners, off(), onlyOnce, and query-window child events oracle captures (in-page sandbox)', () => {
  it('rtdb-modular-onvalue-initial-descendant-and-suppression (rtdb-modular#M26..#M29)', async () => {
    const actual = await withListenersSandbox((db, sdk) =>
      observeOnValueInitialDescendantAndSuppression(
        {
          db,
          ref: sdk.ref as unknown as OnValueSuppressionProbeSdk['ref'],
          child: sdk.child as unknown as OnValueSuppressionProbeSdk['child'],
          set: sdk.set as unknown as OnValueSuppressionProbeSdk['set'],
          update: sdk.update as unknown as OnValueSuppressionProbeSdk['update'],
          onValue: sdk.onValue as unknown as OnValueSuppressionProbeSdk['onValue'],
        },
        'pyric_oracle/replay',
      ),
    );
    expect(actual as unknown).toEqual(obs('rtdb-modular-onvalue-initial-descendant-and-suppression'));
  });

  it('rtdb-modular-onvalue-onlyonce-and-unsub-return (rtdb-modular#M30, #M74, #132)', async () => {
    const actual = await withListenersSandbox((db, sdk) =>
      observeOnValueOnlyOnceAndUnsubReturn(
        {
          db,
          ref: sdk.ref as unknown as OnValueOnlyOnceAndUnsubSdk['ref'],
          set: sdk.set as unknown as OnValueOnlyOnceAndUnsubSdk['set'],
          onValue: sdk.onValue as unknown as OnValueOnlyOnceAndUnsubSdk['onValue'],
        },
        'pyric_oracle/replay',
      ),
    );
    expect(actual as unknown).toEqual(obs('rtdb-modular-onvalue-onlyonce-and-unsub-return'));
  });

  it('rtdb-modular-off-targeted-and-child-registrars (rtdb-modular#M31, #M44, #M48, #140)', async () => {
    const actual = await withListenersSandbox((db, sdk) =>
      observeOffTargetedAndChildRegistrars(
        {
          db: db as unknown as OffTargetedAndChildRegistrarsSdk['db'],
          ref: sdk.ref as unknown as OffTargetedAndChildRegistrarsSdk['ref'],
          child: sdk.child as unknown as OffTargetedAndChildRegistrarsSdk['child'],
          setWithPriority:
            sdk.setWithPriority as unknown as OffTargetedAndChildRegistrarsSdk['setWithPriority'],
          setPriority: sdk.setPriority as unknown as OffTargetedAndChildRegistrarsSdk['setPriority'],
          remove: sdk.remove as unknown as OffTargetedAndChildRegistrarsSdk['remove'],
          onValue: sdk.onValue as unknown as OffTargetedAndChildRegistrarsSdk['onValue'],
          onChildAdded:
            sdk.onChildAdded as unknown as OffTargetedAndChildRegistrarsSdk['onChildAdded'],
          onChildChanged:
            sdk.onChildChanged as unknown as OffTargetedAndChildRegistrarsSdk['onChildChanged'],
          onChildRemoved:
            sdk.onChildRemoved as unknown as OffTargetedAndChildRegistrarsSdk['onChildRemoved'],
          onChildMoved:
            sdk.onChildMoved as unknown as OffTargetedAndChildRegistrarsSdk['onChildMoved'],
          off: sdk.off as unknown as OffTargetedAndChildRegistrarsSdk['off'],
        },
        'pyric_oracle/replay',
      ),
    );
    expect(actual as unknown).toEqual(obs('rtdb-modular-off-targeted-and-child-registrars'));
  });

  it('rtdb-modular-query-window-child-listeners (rtdb-modular#M75b)', async () => {
    const actual = await withListenersSandbox((db, sdk) =>
      observeQueryWindowChildListeners(
        {
          db: db as unknown as QueryWindowChildListenersSdk['db'],
          ref: sdk.ref as unknown as QueryWindowChildListenersSdk['ref'],
          child: sdk.child as unknown as QueryWindowChildListenersSdk['child'],
          set: sdk.set as unknown as QueryWindowChildListenersSdk['set'],
          query: sdk.query as unknown as QueryWindowChildListenersSdk['query'],
          orderByChild:
            sdk.orderByChild as unknown as QueryWindowChildListenersSdk['orderByChild'],
          limitToFirst:
            sdk.limitToFirst as unknown as QueryWindowChildListenersSdk['limitToFirst'],
          onValue: sdk.onValue as unknown as QueryWindowChildListenersSdk['onValue'],
          onChildAdded:
            sdk.onChildAdded as unknown as QueryWindowChildListenersSdk['onChildAdded'],
          onChildChanged:
            sdk.onChildChanged as unknown as QueryWindowChildListenersSdk['onChildChanged'],
          onChildRemoved:
            sdk.onChildRemoved as unknown as QueryWindowChildListenersSdk['onChildRemoved'],
          onChildMoved:
            sdk.onChildMoved as unknown as QueryWindowChildListenersSdk['onChildMoved'],
        },
        'pyric_oracle/replay',
      ),
    );
    expect(actual as unknown).toEqual(obs('rtdb-modular-query-window-child-listeners'));
  });
});
