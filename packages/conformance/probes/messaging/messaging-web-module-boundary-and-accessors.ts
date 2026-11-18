import type { Probe } from '../../rigs/types.ts';
import {
  captureSyncThrow,
  withSyntheticMessagingBrowserEnv,
  type SyncThrowOutcome,
} from '../../src/messaging-web-probe-env.ts';

export interface MessagingModuleBoundaryAndAccessorsBehavior {
  clientExports: {
    hasGetMessaging: boolean;
    hasGetToken: boolean;
    hasDeleteToken: boolean;
    hasOnMessage: boolean;
    hasIsSupported: boolean;
    hasOnBackgroundMessage: boolean;
    hasExperimentalMetricsToggle: boolean;
    hasErrorCode: boolean;
  };
  swExports: {
    hasGetMessaging: boolean;
    hasOnBackgroundMessage: boolean;
    hasExperimentalMetricsToggle: boolean;
    hasIsSupported: boolean;
    hasGetToken: boolean;
    hasDeleteToken: boolean;
    hasOnMessage: boolean;
    hasErrorCode: boolean;
  };
  noDefaultApp: {
    clientGetMessaging: SyncThrowOutcome;
    swGetMessaging: SyncThrowOutcome;
  };
  cachingAndPlaneSeparation: {
    clientDefaultMatchesExplicitDefault: boolean;
    swDefaultMatchesExplicitDefault: boolean;
    clientSameAppCached: boolean;
    swSameAppCached: boolean;
    clientDistinctAcrossNamedApps: boolean;
    swDistinctAcrossNamedApps: boolean;
    clientAndSwDistinctOnSameApp: boolean;
  };
  afterDeleteApp: {
    priorClientInstanceReturnedAfterDelete: boolean;
    priorSwInstanceReturnedAfterDelete: boolean;
    firstClientGetMessagingAfterDelete: SyncThrowOutcome;
    firstSwGetMessagingAfterDelete: SyncThrowOutcome;
  };
}

const VALID_FCM_OPTIONS = {
  projectId: 'demo-fcm-project',
  apiKey: 'demo-fcm-api-key',
  appId: '1:123456789012:web:0a1b2c3d4e5f60718293a4',
  messagingSenderId: '123456789012',
};

export async function observeMessagingModuleBoundaryAndAccessors(): Promise<MessagingModuleBoundaryAndAccessorsBehavior> {
  const [appSdk, clientMod, swMod] = await Promise.all([
    import('firebase/app'),
    import('firebase/messaging'),
    import('firebase/messaging/sw'),
  ]);
  const clientRecord = clientMod as Record<string, unknown>;
  const swRecord = swMod as Record<string, unknown>;

  const clientExports = {
    hasGetMessaging: typeof clientRecord.getMessaging === 'function',
    hasGetToken: typeof clientRecord.getToken === 'function',
    hasDeleteToken: typeof clientRecord.deleteToken === 'function',
    hasOnMessage: typeof clientRecord.onMessage === 'function',
    hasIsSupported: typeof clientRecord.isSupported === 'function',
    hasOnBackgroundMessage: 'onBackgroundMessage' in clientRecord,
    hasExperimentalMetricsToggle:
      'experimentalSetDeliveryMetricsExportedToBigQueryEnabled' in clientRecord,
    hasErrorCode: 'ErrorCode' in clientRecord,
  };

  const swExports = {
    hasGetMessaging: typeof swRecord.getMessaging === 'function',
    hasOnBackgroundMessage: typeof swRecord.onBackgroundMessage === 'function',
    hasExperimentalMetricsToggle:
      typeof swRecord.experimentalSetDeliveryMetricsExportedToBigQueryEnabled === 'function',
    hasIsSupported: typeof swRecord.isSupported === 'function',
    hasGetToken: 'getToken' in swRecord,
    hasDeleteToken: 'deleteToken' in swRecord,
    hasOnMessage: 'onMessage' in swRecord,
    hasErrorCode: 'ErrorCode' in swRecord,
  };

  return withSyntheticMessagingBrowserEnv(async () => {
    const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const createdApps: Array<ReturnType<typeof appSdk.initializeApp>> = [];

    try {
      const noDefaultApp = {
        clientGetMessaging: captureSyncThrow(() => clientMod.getMessaging()),
        swGetMessaging: captureSyncThrow(() => swMod.getMessaging()),
      };

      const defaultApp = appSdk.initializeApp(VALID_FCM_OPTIONS);
      let clientDefaultMatchesExplicitDefault = false;
      let swDefaultMatchesExplicitDefault = false;
      try {
        clientDefaultMatchesExplicitDefault =
          clientMod.getMessaging() === clientMod.getMessaging(defaultApp);
        swDefaultMatchesExplicitDefault =
          swMod.getMessaging() === swMod.getMessaging(defaultApp);
        await new Promise((resolve) => setTimeout(resolve, 10));
      } finally {
        await appSdk.deleteApp(defaultApp);
      }

      const appA = appSdk.initializeApp(VALID_FCM_OPTIONS, `fcm-boundary-a-${runSuffix}`);
      createdApps.push(appA);
      const appB = appSdk.initializeApp(VALID_FCM_OPTIONS, `fcm-boundary-b-${runSuffix}`);
      createdApps.push(appB);

      const clientA1 = clientMod.getMessaging(appA);
      const clientA2 = clientMod.getMessaging(appA);
      const clientB = clientMod.getMessaging(appB);

      const swA1 = swMod.getMessaging(appA);
      const swA2 = swMod.getMessaging(appA);
      const swB = swMod.getMessaging(appB);

      const cachingAndPlaneSeparation = {
        clientDefaultMatchesExplicitDefault,
        swDefaultMatchesExplicitDefault,
        clientSameAppCached: clientA1 === clientA2,
        swSameAppCached: swA1 === swA2,
        clientDistinctAcrossNamedApps: clientA1 !== clientB,
        swDistinctAcrossNamedApps: swA1 !== swB,
        clientAndSwDistinctOnSameApp: (clientA1 as unknown) !== (swA1 as unknown),
      };

      const priorApp = appSdk.initializeApp(
        VALID_FCM_OPTIONS,
        `fcm-boundary-prior-${runSuffix}`,
      );
      const priorClient = clientMod.getMessaging(priorApp);
      const priorSw = swMod.getMessaging(priorApp);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await appSdk.deleteApp(priorApp);

      const freshClientDeletedApp = appSdk.initializeApp(
        VALID_FCM_OPTIONS,
        `fcm-boundary-fresh-client-${runSuffix}`,
      );
      await appSdk.deleteApp(freshClientDeletedApp);

      const freshSwDeletedApp = appSdk.initializeApp(
        VALID_FCM_OPTIONS,
        `fcm-boundary-fresh-sw-${runSuffix}`,
      );
      await appSdk.deleteApp(freshSwDeletedApp);

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

      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        clientExports,
        swExports,
        noDefaultApp,
        cachingAndPlaneSeparation,
        afterDeleteApp,
      };
    } finally {
      await Promise.all(createdApps.map((app) => appSdk.deleteApp(app).catch(() => undefined)));
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
    'firebase/messaging and firebase/messaging/sw module export boundaries, separate messaging vs messaging-sw component caching per FirebaseApp, default-app resolution (including app/no-app), and post-deleteApp handle caching vs first-access app/app-deleted throws.',
  async observe() {
    const observed = await observeMessagingModuleBoundaryAndAccessors();
    return { ...observed };
  },
};
