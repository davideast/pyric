import type { Probe } from '../../rigs/types.ts';
import { withSyntheticMessagingBrowserEnv } from '../../src/messaging-web-probe-env.ts';

interface ListenerModeObservation {
  unsubscribeIsFunction: boolean;
  countBeforeUnsubscribe: number;
  firstDataStep: string | null;
  unsubscribeReturnsUndefined: boolean;
  secondUnsubscribeReturnsUndefined: boolean;
  countAfterUnsubscribeAndRedeliver: number;
}

export interface MessagingObserverAndUnsubscribeBehavior {
  foregroundOnMessage: {
    nextFn: ListenerModeObservation;
    observer: ListenerModeObservation;
  };
  backgroundOnBackgroundMessage: {
    nextFn: ListenerModeObservation;
    observer: ListenerModeObservation;
  };
}

const VALID_FCM_OPTIONS = {
  projectId: 'demo-fcm-project',
  apiKey: 'demo-fcm-api-key',
  appId: '1:123456789012:web:0a1b2c3d4e5f60718293a4',
  messagingSenderId: '123456789012',
};

export async function observeMessagingObserverAndUnsubscribe(): Promise<MessagingObserverAndUnsubscribeBehavior> {
  const [appSdk, clientMod, swMod] = await Promise.all([
    import('firebase/app'),
    import('firebase/messaging'),
    import('firebase/messaging/sw'),
  ]);

  return withSyntheticMessagingBrowserEnv(async (env) => {
    const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const app = appSdk.initializeApp(VALID_FCM_OPTIONS, `fcm-observer-${runSuffix}`);

    try {
      const clientMessaging = clientMod.getMessaging(app);
      const swMessaging = swMod.getMessaging(app);

      const fgNextPayloads: Array<{ data?: Record<string, string> }> = [];
      const unsubFgNext = clientMod.onMessage(clientMessaging, (payload) => {
        fgNextPayloads.push(payload);
      });
      await env.dispatchWindowSwMessage({
        from: '123456789012',
        fcmMessageId: 'fg-next-1',
        collapseKey: 'fg-ck',
        data: { step: 'fg-next-1' },
      });
      const fgNextCountBefore = fgNextPayloads.length;
      let fgNextFirstStep: string | null = null;
      if (fgNextPayloads[0]?.data?.step !== undefined) {
        fgNextFirstStep = fgNextPayloads[0].data.step;
      }
      const fgNextFirstUnsubResult = unsubFgNext();
      const fgNextSecondUnsubResult = unsubFgNext();
      await env.dispatchWindowSwMessage({
        from: '123456789012',
        fcmMessageId: 'fg-next-2',
        collapseKey: 'fg-ck',
        data: { step: 'fg-next-2' },
      });

      const fgObsPayloads: Array<{ data?: Record<string, string> }> = [];
      const unsubFgObs = clientMod.onMessage(clientMessaging, {
        next: (payload) => {
          fgObsPayloads.push(payload);
        },
        error: () => {},
        complete: () => {},
      });
      await env.dispatchWindowSwMessage({
        from: '123456789012',
        fcmMessageId: 'fg-obs-1',
        collapseKey: 'fg-ck',
        data: { step: 'fg-obs-1' },
      });
      const fgObsCountBefore = fgObsPayloads.length;
      let fgObsFirstStep: string | null = null;
      if (fgObsPayloads[0]?.data?.step !== undefined) {
        fgObsFirstStep = fgObsPayloads[0].data.step;
      }
      const fgObsFirstUnsubResult = unsubFgObs();
      const fgObsSecondUnsubResult = unsubFgObs();
      await env.dispatchWindowSwMessage({
        from: '123456789012',
        fcmMessageId: 'fg-obs-2',
        collapseKey: 'fg-ck',
        data: { step: 'fg-obs-2' },
      });

      const bgNextPayloads: Array<{ data?: Record<string, string> }> = [];
      const unsubBgNext = swMod.onBackgroundMessage(swMessaging, (payload) => {
        bgNextPayloads.push(payload);
      });
      await env.dispatchSwPush({
        from: '123456789012',
        fcmMessageId: 'bg-next-1',
        collapseKey: 'bg-ck',
        data: { step: 'bg-next-1' },
      });
      const bgNextCountBefore = bgNextPayloads.length;
      let bgNextFirstStep: string | null = null;
      if (bgNextPayloads[0]?.data?.step !== undefined) {
        bgNextFirstStep = bgNextPayloads[0].data.step;
      }
      const bgNextFirstUnsubResult = unsubBgNext();
      const bgNextSecondUnsubResult = unsubBgNext();
      await env.dispatchSwPush({
        from: '123456789012',
        fcmMessageId: 'bg-next-2',
        collapseKey: 'bg-ck',
        data: { step: 'bg-next-2' },
      });

      const bgObsPayloads: Array<{ data?: Record<string, string> }> = [];
      const unsubBgObs = swMod.onBackgroundMessage(swMessaging, {
        next: (payload) => {
          bgObsPayloads.push(payload);
        },
        error: () => {},
        complete: () => {},
      });
      await env.dispatchSwPush({
        from: '123456789012',
        fcmMessageId: 'bg-obs-1',
        collapseKey: 'bg-ck',
        data: { step: 'bg-obs-1' },
      });
      const bgObsCountBefore = bgObsPayloads.length;
      let bgObsFirstStep: string | null = null;
      if (bgObsPayloads[0]?.data?.step !== undefined) {
        bgObsFirstStep = bgObsPayloads[0].data.step;
      }
      const bgObsFirstUnsubResult = unsubBgObs();
      const bgObsSecondUnsubResult = unsubBgObs();
      await env.dispatchSwPush({
        from: '123456789012',
        fcmMessageId: 'bg-obs-2',
        collapseKey: 'bg-ck',
        data: { step: 'bg-obs-2' },
      });

      return {
        foregroundOnMessage: {
          nextFn: {
            unsubscribeIsFunction: typeof unsubFgNext === 'function',
            countBeforeUnsubscribe: fgNextCountBefore,
            firstDataStep: fgNextFirstStep,
            unsubscribeReturnsUndefined: fgNextFirstUnsubResult === undefined,
            secondUnsubscribeReturnsUndefined: fgNextSecondUnsubResult === undefined,
            countAfterUnsubscribeAndRedeliver: fgNextPayloads.length,
          },
          observer: {
            unsubscribeIsFunction: typeof unsubFgObs === 'function',
            countBeforeUnsubscribe: fgObsCountBefore,
            firstDataStep: fgObsFirstStep,
            unsubscribeReturnsUndefined: fgObsFirstUnsubResult === undefined,
            secondUnsubscribeReturnsUndefined: fgObsSecondUnsubResult === undefined,
            countAfterUnsubscribeAndRedeliver: fgObsPayloads.length,
          },
        },
        backgroundOnBackgroundMessage: {
          nextFn: {
            unsubscribeIsFunction: typeof unsubBgNext === 'function',
            countBeforeUnsubscribe: bgNextCountBefore,
            firstDataStep: bgNextFirstStep,
            unsubscribeReturnsUndefined: bgNextFirstUnsubResult === undefined,
            secondUnsubscribeReturnsUndefined: bgNextSecondUnsubResult === undefined,
            countAfterUnsubscribeAndRedeliver: bgNextPayloads.length,
          },
          observer: {
            unsubscribeIsFunction: typeof unsubBgObs === 'function',
            countBeforeUnsubscribe: bgObsCountBefore,
            firstDataStep: bgObsFirstStep,
            unsubscribeReturnsUndefined: bgObsFirstUnsubResult === undefined,
            secondUnsubscribeReturnsUndefined: bgObsSecondUnsubResult === undefined,
            countAfterUnsubscribeAndRedeliver: bgObsPayloads.length,
          },
        },
      };
    } finally {
      await appSdk.deleteApp(app).catch(() => undefined);
    }
  });
}

export const probe: Probe = {
  rig: 'sdk-probes',
  pendingRowLink: true,
  requires: ['web-config'],
  matrixRow: '',
  rowIds: [],
  description:
    'firebase/messaging onMessage and firebase/messaging/sw onBackgroundMessage NextFn, Observer ({ next, error, complete }), and idempotent Unsubscribe teardown behavior.',
  async observe() {
    const observed = await observeMessagingObserverAndUnsubscribe();
    return { ...observed };
  },
};
