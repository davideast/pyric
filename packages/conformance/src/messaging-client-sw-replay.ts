import type { MessagingClientErrorCodesBehavior } from '../probes/messaging/messaging-web-client-error-codes.ts';
import type { MessagingModuleBoundaryAndAccessorsBehavior } from '../probes/messaging/messaging-web-module-boundary-and-accessors.ts';
import type { MessagingObserverAndUnsubscribeBehavior } from '../probes/messaging/messaging-web-observer-and-unsubscribe.ts';
import type { MessagingSwDeliveryMetricsToggleBehavior } from '../probes/messaging/messaging-web-sw-delivery-metrics-toggle.ts';
import { captureAsyncReject, captureSyncThrow } from './messaging-web-probe-env.ts';

interface ReplayMessagingPayload {
  data?: Record<string, string>;
}

interface ReplayMessagingClientModule {
  getMessaging(app?: unknown): unknown;
  getToken(messaging: unknown, options?: Record<string, unknown>): Promise<string>;
  deleteToken(messaging: unknown): Promise<boolean>;
  onMessage(
    messaging: unknown,
    nextOrObserver:
      | ((payload: ReplayMessagingPayload) => void)
      | {
          next: (payload: ReplayMessagingPayload) => void;
          error: (error: Error) => void;
          complete: () => void;
        },
  ): () => void;
  isSupported(): Promise<boolean>;
}

interface ReplayMessagingSwModule {
  getMessaging(app?: unknown): unknown;
  onBackgroundMessage(
    messaging: unknown,
    nextOrObserver:
      | ((payload: ReplayMessagingPayload) => void)
      | {
          next: (payload: ReplayMessagingPayload) => void;
          error: (error: Error) => void;
          complete: () => void;
        },
  ): () => void;
  experimentalSetDeliveryMetricsExportedToBigQueryEnabled(
    messaging: unknown,
    enable: boolean,
  ): unknown;
  isSupported(): Promise<boolean>;
}

export interface MessagingClientSwReplayTarget {
  clientMod: ReplayMessagingClientModule & Record<string, unknown>;
  swMod: ReplayMessagingSwModule & Record<string, unknown>;
  withNoDefaultApp<T>(run: () => T | Promise<T>): Promise<T>;
  withDefaultApp<T>(run: (defaultApp: unknown) => T | Promise<T>): Promise<T>;
  createNamedApp(label: string): unknown;
  deleteApp(app: unknown): Promise<void>;
  deliver(
    messaging: unknown,
    spec: { visibilityState: 'visible' | 'hidden'; data: Record<string, string> },
  ): Promise<void>;
  settleSubscription?(): Promise<void>;
}

export async function replayMessagingModuleBoundaryAndAccessors(
  target: MessagingClientSwReplayTarget,
): Promise<MessagingModuleBoundaryAndAccessorsBehavior> {
  const { clientMod, swMod } = target;

  const clientExports = {
    hasGetMessaging: typeof clientMod.getMessaging === 'function',
    hasGetToken: typeof clientMod.getToken === 'function',
    hasDeleteToken: typeof clientMod.deleteToken === 'function',
    hasOnMessage: typeof clientMod.onMessage === 'function',
    hasIsSupported: typeof clientMod.isSupported === 'function',
    hasOnBackgroundMessage: 'onBackgroundMessage' in clientMod,
    hasExperimentalMetricsToggle:
      'experimentalSetDeliveryMetricsExportedToBigQueryEnabled' in clientMod,
    hasErrorCode: 'ErrorCode' in clientMod,
  };

  const swExports = {
    hasGetMessaging: typeof swMod.getMessaging === 'function',
    hasOnBackgroundMessage: typeof swMod.onBackgroundMessage === 'function',
    hasExperimentalMetricsToggle:
      typeof swMod.experimentalSetDeliveryMetricsExportedToBigQueryEnabled === 'function',
    hasIsSupported: typeof swMod.isSupported === 'function',
    hasGetToken: 'getToken' in swMod,
    hasDeleteToken: 'deleteToken' in swMod,
    hasOnMessage: 'onMessage' in swMod,
    hasErrorCode: 'ErrorCode' in swMod,
  };

  const noDefaultApp = await target.withNoDefaultApp(() => ({
    clientGetMessaging: captureSyncThrow(() => clientMod.getMessaging()),
    swGetMessaging: captureSyncThrow(() => swMod.getMessaging()),
  }));

  const defaultMatches = await target.withDefaultApp((defaultApp) => ({
    clientDefaultMatchesExplicitDefault:
      clientMod.getMessaging() === clientMod.getMessaging(defaultApp),
    swDefaultMatchesExplicitDefault:
      swMod.getMessaging() === swMod.getMessaging(defaultApp),
  }));

  const appA = target.createNamedApp('boundary-a');
  const appB = target.createNamedApp('boundary-b');
  try {
    const clientA1 = clientMod.getMessaging(appA);
    const clientA2 = clientMod.getMessaging(appA);
    const clientB = clientMod.getMessaging(appB);

    const swA1 = swMod.getMessaging(appA);
    const swA2 = swMod.getMessaging(appA);
    const swB = swMod.getMessaging(appB);

    const cachingAndPlaneSeparation = {
      clientDefaultMatchesExplicitDefault:
        defaultMatches.clientDefaultMatchesExplicitDefault,
      swDefaultMatchesExplicitDefault: defaultMatches.swDefaultMatchesExplicitDefault,
      clientSameAppCached: clientA1 === clientA2,
      swSameAppCached: swA1 === swA2,
      clientDistinctAcrossNamedApps: clientA1 !== clientB,
      swDistinctAcrossNamedApps: swA1 !== swB,
      clientAndSwDistinctOnSameApp: clientA1 !== swA1,
    };

    const priorApp = target.createNamedApp('boundary-prior');
    const priorClient = clientMod.getMessaging(priorApp);
    const priorSw = swMod.getMessaging(priorApp);
    await target.deleteApp(priorApp);

    const freshClientDeletedApp = target.createNamedApp('boundary-fresh-client');
    await target.deleteApp(freshClientDeletedApp);

    const freshSwDeletedApp = target.createNamedApp('boundary-fresh-sw');
    await target.deleteApp(freshSwDeletedApp);

    const afterDeleteApp = {
      priorClientInstanceReturnedAfterDelete:
        clientMod.getMessaging(priorApp) === priorClient,
      priorSwInstanceReturnedAfterDelete: swMod.getMessaging(priorApp) === priorSw,
      firstClientGetMessagingAfterDelete: captureSyncThrow(() =>
        clientMod.getMessaging(freshClientDeletedApp),
      ),
      firstSwGetMessagingAfterDelete: captureSyncThrow(() =>
        swMod.getMessaging(freshSwDeletedApp),
      ),
    };

    return {
      clientExports,
      swExports,
      noDefaultApp,
      cachingAndPlaneSeparation,
      afterDeleteApp,
    };
  } finally {
    await target.deleteApp(appA).catch(() => undefined);
    await target.deleteApp(appB).catch(() => undefined);
  }
}

export async function replayMessagingObserverAndUnsubscribe(
  target: MessagingClientSwReplayTarget,
): Promise<MessagingObserverAndUnsubscribeBehavior> {
  const { clientMod, swMod } = target;
  const fgApp = target.createNamedApp('observer-unsub-fg');
  const bgApp = target.createNamedApp('observer-unsub-bg');

  try {
    const clientMessaging = clientMod.getMessaging(fgApp);

    const fgNextPayloads: ReplayMessagingPayload[] = [];
    const unsubFgNext = clientMod.onMessage(clientMessaging, (payload) => {
      fgNextPayloads.push(payload);
    });
    if (target.settleSubscription !== undefined) {
      await target.settleSubscription();
    }
    await target.deliver(clientMessaging, {
      visibilityState: 'visible',
      data: { step: 'fg-next-1' },
    });
    const fgNextCountBefore = fgNextPayloads.length;
    let fgNextFirstStep: string | null = null;
    if (fgNextPayloads[0]?.data?.step !== undefined) {
      fgNextFirstStep = fgNextPayloads[0].data.step;
    }
    const fgNextFirstUnsubResult = unsubFgNext();
    const fgNextSecondUnsubResult = unsubFgNext();
    await target.deliver(clientMessaging, {
      visibilityState: 'visible',
      data: { step: 'fg-next-2' },
    });

    const fgObsPayloads: ReplayMessagingPayload[] = [];
    const unsubFgObs = clientMod.onMessage(clientMessaging, {
      next: (payload) => {
        fgObsPayloads.push(payload);
      },
      error: () => {},
      complete: () => {},
    });
    if (target.settleSubscription !== undefined) {
      await target.settleSubscription();
    }
    await target.deliver(clientMessaging, {
      visibilityState: 'visible',
      data: { step: 'fg-obs-1' },
    });
    const fgObsCountBefore = fgObsPayloads.length;
    let fgObsFirstStep: string | null = null;
    if (fgObsPayloads[0]?.data?.step !== undefined) {
      fgObsFirstStep = fgObsPayloads[0].data.step;
    }
    const fgObsFirstUnsubResult = unsubFgObs();
    const fgObsSecondUnsubResult = unsubFgObs();
    await target.deliver(clientMessaging, {
      visibilityState: 'visible',
      data: { step: 'fg-obs-2' },
    });
    await target.deliver(clientMessaging, {
      visibilityState: 'hidden',
      data: { step: 'fg-park-hidden' },
    });

    await target.deleteApp(fgApp);
    const swMessaging = swMod.getMessaging(bgApp);

    const bgNextPayloads: ReplayMessagingPayload[] = [];
    const unsubBgNext = swMod.onBackgroundMessage(swMessaging, (payload) => {
      bgNextPayloads.push(payload);
    });
    if (target.settleSubscription !== undefined) {
      await target.settleSubscription();
    }
    await target.deliver(swMessaging, {
      visibilityState: 'hidden',
      data: { step: 'bg-next-1' },
    });
    const bgNextCountBefore = bgNextPayloads.length;
    let bgNextFirstStep: string | null = null;
    if (bgNextPayloads[0]?.data?.step !== undefined) {
      bgNextFirstStep = bgNextPayloads[0].data.step;
    }
    const bgNextFirstUnsubResult = unsubBgNext();
    const bgNextSecondUnsubResult = unsubBgNext();
    await target.deliver(swMessaging, {
      visibilityState: 'hidden',
      data: { step: 'bg-next-2' },
    });

    const bgObsPayloads: ReplayMessagingPayload[] = [];
    const unsubBgObs = swMod.onBackgroundMessage(swMessaging, {
      next: (payload) => {
        bgObsPayloads.push(payload);
      },
      error: () => {},
      complete: () => {},
    });
    if (target.settleSubscription !== undefined) {
      await target.settleSubscription();
    }
    await target.deliver(swMessaging, {
      visibilityState: 'hidden',
      data: { step: 'bg-obs-1' },
    });
    const bgObsCountBefore = bgObsPayloads.length;
    let bgObsFirstStep: string | null = null;
    if (bgObsPayloads[0]?.data?.step !== undefined) {
      bgObsFirstStep = bgObsPayloads[0].data.step;
    }
    const bgObsFirstUnsubResult = unsubBgObs();
    const bgObsSecondUnsubResult = unsubBgObs();
    await target.deliver(swMessaging, {
      visibilityState: 'hidden',
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
    await target.deleteApp(fgApp).catch(() => undefined);
    await target.deleteApp(bgApp).catch(() => undefined);
  }
}

export async function replayMessagingSwDeliveryMetricsToggle(
  target: MessagingClientSwReplayTarget,
): Promise<MessagingSwDeliveryMetricsToggleBehavior> {
  const { swMod } = target;
  const app = target.createNamedApp('sw-metrics-toggle');

  try {
    const swMessaging = swMod.getMessaging(app);
    const deliveredStepsAcrossToggleStates: string[] = [];
    const unsub = swMod.onBackgroundMessage(swMessaging, (payload) => {
      if (payload.data?.phase !== undefined) {
        deliveredStepsAcrossToggleStates.push(payload.data.phase);
      }
    });
    if (target.settleSubscription !== undefined) {
      await target.settleSubscription();
    }

    let enableResult: unknown;
    let disableResult: unknown;
    try {
      enableResult = swMod.experimentalSetDeliveryMetricsExportedToBigQueryEnabled(
        swMessaging,
        true,
      );
      await target.deliver(swMessaging, {
        visibilityState: 'hidden',
        data: { phase: 'enabled' },
      });

      disableResult = swMod.experimentalSetDeliveryMetricsExportedToBigQueryEnabled(
        swMessaging,
        false,
      );
      await target.deliver(swMessaging, {
        visibilityState: 'hidden',
        data: { phase: 'disabled' },
      });
    } finally {
      swMod.experimentalSetDeliveryMetricsExportedToBigQueryEnabled(swMessaging, false);
      unsub();
    }

    const nullOutcome = captureSyncThrow(() =>
      swMod.experimentalSetDeliveryMetricsExportedToBigQueryEnabled(null, true),
    );

    return {
      enableReturnsUndefined: enableResult === undefined,
      disableReturnsUndefined: disableResult === undefined,
      deliveredStepsAcrossToggleStates,
      nullMessagingThrowsSynchronously: nullOutcome.threw,
    };
  } finally {
    await target.deleteApp(app).catch(() => undefined);
  }
}

export async function replayMessagingClientErrorCodes(
  target: MessagingClientSwReplayTarget,
): Promise<MessagingClientErrorCodesBehavior> {
  const { clientMod, swMod } = target;
  const app = target.createNamedApp('client-errors');
  const globalObj = globalThis as Record<string, unknown>;
  const hadNotification = Object.prototype.hasOwnProperty.call(globalObj, 'Notification');
  const prevNotification = Object.getOwnPropertyDescriptor(globalObj, 'Notification');

  try {
    const messaging = clientMod.getMessaging(app);

    Object.defineProperty(globalObj, 'Notification', {
      value: { permission: 'denied' },
      configurable: true,
      writable: true,
    });
    const permissionDeniedGetToken = await captureAsyncReject(() =>
      clientMod.getToken(messaging),
    );

    Object.defineProperty(globalObj, 'Notification', {
      value: { permission: 'granted' },
      configurable: true,
      writable: true,
    });
    const primitiveSwRegistrationGetToken = await captureAsyncReject(() =>
      clientMod.getToken(messaging, {
        serviceWorkerRegistration: 'not-a-sw-registration',
      }),
    );

    const malformedObjectSwRegistrationGetToken = await captureAsyncReject(() =>
      clientMod.getToken(messaging, {
        serviceWorkerRegistration: {},
      }),
    );

    return {
      hasClientErrorCodeExport: 'ErrorCode' in clientMod,
      hasSwErrorCodeExport: 'ErrorCode' in swMod,
      permissionDeniedGetToken,
      primitiveSwRegistrationGetToken,
      malformedObjectSwRegistrationGetToken,
    };
  } finally {
    if (hadNotification && prevNotification !== undefined) {
      Object.defineProperty(globalObj, 'Notification', prevNotification);
    } else {
      delete globalObj.Notification;
    }
    await target.deleteApp(app).catch(() => undefined);
  }
}
