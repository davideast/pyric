import type { Probe } from '../../rigs/types.ts';

type DebugTokenGlobal = {
  FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown;
};

interface CustomProviderRejectionOutcome {
  threw: boolean;
  sameErrorInstance: boolean;
  message: string | null;
}

interface CustomProviderListenerEvent {
  kind: 'next' | 'error';
  sameErrorInstance?: boolean;
  message?: string;
}

interface CustomProviderWithoutDebugTokenBehavior {
  customTokenCachingAndLimitedUse: {
    firstGetToken: { token: string };
    secondGetToken: { token: string };
    secondEqualsFirst: boolean;
    callsAfterFirstGetToken: number;
    callsAfterSecondGetToken: number;
    limitedUseToken: { token: string };
    callsAfterLimitedUseToken: number;
  };
  providerRejection: {
    getTokenOutcome: CustomProviderRejectionOutcome;
    getLimitedUseTokenOutcome: CustomProviderRejectionOutcome;
    listenerEvents: CustomProviderListenerEvent[];
    callsAfterBothRejections: number;
  };
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function captureProviderRejection(
  operation: () => Promise<unknown>,
  expectedError: Error,
): Promise<CustomProviderRejectionOutcome> {
  try {
    await operation();
    return {
      threw: false,
      sameErrorInstance: false,
      message: null,
    };
  } catch (error) {
    return {
      threw: true,
      sameErrorInstance: error === expectedError,
      message: errorMessageOf(error),
    };
  }
}

export async function observeCustomProviderWithoutDebugToken(): Promise<CustomProviderWithoutDebugTokenBehavior> {
  const [appSdk, appCheckSdk] = await Promise.all([
    import('firebase/app'),
    import('firebase/app-check'),
  ]);
  const debugGlobal = globalThis as DebugTokenGlobal;
  const hadDebugToken = Object.prototype.hasOwnProperty.call(
    debugGlobal,
    'FIREBASE_APPCHECK_DEBUG_TOKEN',
  );
  const previousDebugToken = debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN;
  delete debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN;

  const createdApps: ReturnType<typeof appSdk.initializeApp>[] = [];
  const options = {
    projectId: 'demo-project',
    apiKey: 'demo-api-key',
    appId: '1:123456789012:web:0a1b2c3d4e5f60718293a4',
  };
  const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    let successCalls = 0;
    const expireTimeMillis = Date.now() + 3_600_000;
    const customProvider = new appCheckSdk.CustomProvider({
      getToken: async () => {
        successCalls += 1;
        return {
          token: 'not-an-app-check-token',
          expireTimeMillis,
        };
      },
    });
    const successApp = appSdk.initializeApp(options, `custom-provider-ok-${runSuffix}`);
    createdApps.push(successApp);
    const successHandle = appCheckSdk.initializeAppCheck(successApp, {
      provider: customProvider,
      isTokenAutoRefreshEnabled: false,
    });

    const firstGetToken = await appCheckSdk.getToken(successHandle);
    const callsAfterFirstGetToken = successCalls;
    const secondGetToken = await appCheckSdk.getToken(successHandle);
    const callsAfterSecondGetToken = successCalls;
    const limitedUseToken = await appCheckSdk.getLimitedUseToken(successHandle);
    const callsAfterLimitedUseToken = successCalls;

    let failureCalls = 0;
    const failure = new Error('attestation failed');
    const failingProvider = new appCheckSdk.CustomProvider({
      getToken: async () => {
        failureCalls += 1;
        throw failure;
      },
    });
    const failingApp = appSdk.initializeApp(options, `custom-provider-fail-${runSuffix}`);
    createdApps.push(failingApp);
    const failingHandle = appCheckSdk.initializeAppCheck(failingApp, {
      provider: failingProvider,
      isTokenAutoRefreshEnabled: false,
    });

    const listenerEvents: CustomProviderListenerEvent[] = [];
    const unsubscribe = appCheckSdk.onTokenChanged(
      failingHandle,
      () => {
        listenerEvents.push({ kind: 'next' });
      },
      (error) => {
        listenerEvents.push({
          kind: 'error',
          sameErrorInstance: error === failure,
          message: errorMessageOf(error),
        });
      },
    );

    const getTokenOutcome = await captureProviderRejection(
      () => appCheckSdk.getToken(failingHandle),
      failure,
    );
    const getLimitedUseTokenOutcome = await captureProviderRejection(
      () => appCheckSdk.getLimitedUseToken(failingHandle),
      failure,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    unsubscribe();

    return {
      customTokenCachingAndLimitedUse: {
        firstGetToken: { token: firstGetToken.token },
        secondGetToken: { token: secondGetToken.token },
        secondEqualsFirst: secondGetToken.token === firstGetToken.token,
        callsAfterFirstGetToken,
        callsAfterSecondGetToken,
        limitedUseToken: { token: limitedUseToken.token },
        callsAfterLimitedUseToken,
      },
      providerRejection: {
        getTokenOutcome,
        getLimitedUseTokenOutcome,
        listenerEvents,
        callsAfterBothRejections: failureCalls,
      },
    };
  } finally {
    await Promise.all(createdApps.map((app) => appSdk.deleteApp(app).catch(() => undefined)));
    if (hadDebugToken) {
      debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN = previousDebugToken;
    } else {
      delete debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN;
    }
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase/app-check CustomProvider behavior with FIREBASE_APPCHECK_DEBUG_TOKEN unset: getToken returns and caches the provider token until expireTimeMillis, getLimitedUseToken invokes the provider without using the cached token, and a provider rejection propagates the exact error to getToken, getLimitedUseToken, and onTokenChanged error listeners.',
  async observe() {
    const observed = await observeCustomProviderWithoutDebugToken();
    return { ...observed };
  },
};
