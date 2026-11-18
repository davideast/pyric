import type { FirebaseApp } from 'pyric/app';
import * as appCheck from 'pyric/app-check';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function countingProvider(
  answer: () => Promise<{ token: string; expireTimeMillis: number }>,
): { instance: appCheck.CustomProvider; readonly calls: number } {
  const counter = { calls: 0 };
  const instance = new appCheck.CustomProvider({
    getToken: async () => {
      counter.calls += 1;
      return answer();
    },
  });
  return {
    instance,
    get calls(): number {
      return counter.calls;
    },
  };
}

export async function replayCustomProviderWithoutDebugToken(
  freshApp: (label: string) => FirebaseApp,
): Promise<{
  customTokenCachingAndLimitedUse: Record<string, unknown>;
  providerRejection: Record<string, unknown>;
}> {
  const expireTimeMillis = Date.now() + 3_600_000;
  const garbage = countingProvider(async () => ({
    token: 'not-an-app-check-token',
    expireTimeMillis,
  }));
  const given = appCheck.initializeAppCheck(freshApp('custom-given'), {
    provider: garbage.instance,
    isTokenAutoRefreshEnabled: false,
  });
  const firstGetToken = await appCheck.getToken(given);
  const callsAfterFirstGetToken = garbage.calls;
  const secondGetToken = await appCheck.getToken(given);
  const callsAfterSecondGetToken = garbage.calls;
  const limitedUseToken = await appCheck.getLimitedUseToken(given);
  const callsAfterLimitedUseToken = garbage.calls;

  const failure = new Error('attestation failed');
  const failing = countingProvider(async () => {
    throw failure;
  });
  const refused = appCheck.initializeAppCheck(freshApp('custom-rejects'), {
    provider: failing.instance,
    isTokenAutoRefreshEnabled: false,
  });
  const listenerEvents: Array<{ kind: string; sameErrorInstance?: boolean; message?: string }> = [];
  const unsubscribe = appCheck.onTokenChanged(
    refused,
    () => {
      listenerEvents.push({ kind: 'next' });
    },
    (error) => {
      listenerEvents.push({
        kind: 'error',
        sameErrorInstance: error === failure,
        message: error.message,
      });
    },
  );
  const captureOutcome = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return { threw: false, sameErrorInstance: false, message: null };
    } catch (error) {
      let message = String(error);
      if (error instanceof Error) {
        message = error.message;
      }
      return { threw: true, sameErrorInstance: error === failure, message };
    }
  };
  const getTokenOutcome = await captureOutcome(() => appCheck.getToken(refused));
  const getLimitedUseTokenOutcome = await captureOutcome(() => appCheck.getLimitedUseToken(refused));
  await sleep(10);
  unsubscribe();

  return {
    customTokenCachingAndLimitedUse: {
      firstGetToken,
      secondGetToken,
      secondEqualsFirst: secondGetToken.token === firstGetToken.token,
      callsAfterFirstGetToken,
      callsAfterSecondGetToken,
      limitedUseToken,
      callsAfterLimitedUseToken,
    },
    providerRejection: {
      getTokenOutcome,
      getLimitedUseTokenOutcome,
      listenerEvents,
      callsAfterBothRejections: failing.calls,
    },
  };
}

function captureSyncInit(operation: () => unknown, appName: string): Record<string, unknown> {
  try {
    operation();
    return {
      synchronousThrow: false,
      name: null,
      code: null,
      message: null,
      customDataMatchesAppName: false,
    };
  } catch (error) {
    const shaped = error as {
      name?: unknown;
      code?: unknown;
      message?: unknown;
      customData?: { appName?: unknown };
    };
    let name: string | null = null;
    if (typeof shaped.name === 'string') {
      name = shaped.name;
    }
    let code: string | null = null;
    if (typeof shaped.code === 'string') {
      code = shaped.code;
    }
    let message = String(error);
    if (typeof shaped.message === 'string') {
      message = shaped.message;
    }
    message = message.replaceAll(appName, '<appName>');
    return {
      synchronousThrow: true,
      name,
      code,
      message,
      customDataMatchesAppName: shaped.customData?.appName === appName,
    };
  }
}

export function replayRecaptchaProvidersWithoutDocumentMode(
  freshApp: (label: string) => FirebaseApp,
): Record<string, unknown> {
  const runProviderCase = (
    make: (siteKey: string) => appCheck.ReCaptchaV3Provider | appCheck.ReCaptchaEnterpriseProvider,
  ) => {
    const app = freshApp('recaptcha-no-document');
    const firstInitialize = captureSyncInit(
      () => appCheck.initializeAppCheck(app, { provider: make('demo-site-key') }),
      app.name,
    );
    const handle = appCheck.initializeAppCheck(app, { provider: make('demo-site-key') });
    const secondSameSiteKey = {
      synchronousThrow: false,
      returnsAppCheckForSameApp: handle.app === app,
    };
    const thirdDifferentSiteKey = captureSyncInit(
      () => appCheck.initializeAppCheck(app, { provider: make('another-site-key') }),
      app.name,
    );
    return { firstInitialize, secondSameSiteKey, thirdDifferentSiteKey };
  };

  return {
    recaptchaV3: runProviderCase((siteKey) => new appCheck.ReCaptchaV3Provider(siteKey)),
    recaptchaEnterprise: runProviderCase(
      (siteKey) => new appCheck.ReCaptchaEnterpriseProvider(siteKey),
    ),
  };
}
