import type { Probe } from '../../rigs/types.ts';
import {
  captureAsyncReject,
  withSyntheticMessagingBrowserEnv,
  type SyncThrowOutcome,
} from '../../src/messaging-web-probe-env.ts';

export interface MessagingClientErrorCodesBehavior {
  hasClientErrorCodeExport: boolean;
  hasSwErrorCodeExport: boolean;
  permissionDeniedGetToken: SyncThrowOutcome;
  primitiveSwRegistrationGetToken: SyncThrowOutcome;
  malformedObjectSwRegistrationGetToken: SyncThrowOutcome;
}

const VALID_FCM_OPTIONS = {
  projectId: 'demo-fcm-project',
  apiKey: 'demo-fcm-api-key',
  appId: '1:123456789012:web:0a1b2c3d4e5f60718293a4',
  messagingSenderId: '123456789012',
};

export async function observeMessagingClientErrorCodes(): Promise<MessagingClientErrorCodesBehavior> {
  const [appSdk, clientMod, swMod] = await Promise.all([
    import('firebase/app'),
    import('firebase/messaging'),
    import('firebase/messaging/sw'),
  ]);
  const clientRecord = clientMod as Record<string, unknown>;
  const swRecord = swMod as Record<string, unknown>;

  return withSyntheticMessagingBrowserEnv(async (env) => {
    const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const app = appSdk.initializeApp(VALID_FCM_OPTIONS, `fcm-errors-${runSuffix}`);

    try {
      const messaging = clientMod.getMessaging(app);

      env.setNotificationPermission('denied');
      const permissionDeniedGetToken = await captureAsyncReject(() =>
        clientMod.getToken(messaging),
      );

      env.setNotificationPermission('granted');
      const primitiveSwRegistrationGetToken = await captureAsyncReject(() =>
        clientMod.getToken(messaging, {
          serviceWorkerRegistration:
            'not-a-sw-registration' as unknown as ServiceWorkerRegistration,
        }),
      );

      const malformedObjectSwRegistrationGetToken = await captureAsyncReject(() =>
        clientMod.getToken(messaging, {
          serviceWorkerRegistration: {} as unknown as ServiceWorkerRegistration,
        }),
      );

      return {
        hasClientErrorCodeExport: 'ErrorCode' in clientRecord,
        hasSwErrorCodeExport: 'ErrorCode' in swRecord,
        permissionDeniedGetToken,
        primitiveSwRegistrationGetToken,
        malformedObjectSwRegistrationGetToken,
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
    'firebase/messaging @internal ErrorCode non-export on client and sw entries plus FirebaseError rejection codes for denied notification permission (messaging/permission-blocked) and invalid serviceWorkerRegistration inputs (messaging/invalid-sw-registration).',
  async observe() {
    const observed = await observeMessagingClientErrorCodes();
    return { ...observed };
  },
};
