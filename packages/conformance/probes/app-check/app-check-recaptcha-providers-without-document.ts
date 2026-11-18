import type { Probe } from '../../rigs/types.ts';

type DebugTokenGlobal = {
  FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown;
  document?: unknown;
};

interface SyncThrowOutcome {
  synchronousThrow: boolean;
  name: string | null;
  code: string | null;
  message: string | null;
  customDataMatchesAppName: boolean;
}

interface RecaptchaProviderCaseOutcome {
  firstInitialize: SyncThrowOutcome;
  secondSameSiteKey: {
    synchronousThrow: boolean;
    returnsAppCheckForSameApp: boolean;
  };
  thirdDifferentSiteKey: SyncThrowOutcome;
}

interface RecaptchaProvidersWithoutDocumentBehavior {
  hasGlobalDocument: boolean;
  withoutDebugToken: {
    recaptchaV3: RecaptchaProviderCaseOutcome;
    recaptchaEnterprise: RecaptchaProviderCaseOutcome;
  };
  withDebugTokenTrue: {
    recaptchaV3: RecaptchaProviderCaseOutcome;
    recaptchaEnterprise: RecaptchaProviderCaseOutcome;
  };
}

function captureSyncInitializeOutcome(
  operation: () => unknown,
  expectedAppName: string,
): SyncThrowOutcome {
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
    message = message.replaceAll(expectedAppName, '<appName>');
    const appNameInCustomData = shaped.customData?.appName;
    return {
      synchronousThrow: true,
      name,
      code,
      message,
      customDataMatchesAppName: appNameInCustomData === expectedAppName,
    };
  }
}

export async function observeRecaptchaProvidersWithoutDocument(): Promise<RecaptchaProvidersWithoutDocumentBehavior> {
  const [appSdk, appCheckSdk] = await Promise.all([
    import('firebase/app'),
    import('firebase/app-check'),
  ]);
  const runtimeGlobal = globalThis as DebugTokenGlobal;
  const hasGlobalDocument = typeof runtimeGlobal.document !== 'undefined';

  const hadDebugToken = Object.prototype.hasOwnProperty.call(
    runtimeGlobal,
    'FIREBASE_APPCHECK_DEBUG_TOKEN',
  );
  const previousDebugToken = runtimeGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN;

  const createdApps: ReturnType<typeof appSdk.initializeApp>[] = [];
  const options = {
    projectId: 'demo-project',
    apiKey: 'demo-api-key',
    appId: '1:123456789012:web:0a1b2c3d4e5f60718293a4',
  };
  const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let seq = 0;

  const runProviderCase = (
    makeProvider: (
      siteKey: string,
    ) =>
      | InstanceType<typeof appCheckSdk.ReCaptchaV3Provider>
      | InstanceType<typeof appCheckSdk.ReCaptchaEnterpriseProvider>,
  ): RecaptchaProviderCaseOutcome => {
    seq += 1;
    const appName = `recaptcha-no-doc-${runSuffix}-${seq}`;
    const app = appSdk.initializeApp(options, appName);
    createdApps.push(app);

    const firstInitialize = captureSyncInitializeOutcome(
      () => appCheckSdk.initializeAppCheck(app, { provider: makeProvider('demo-site-key') }),
      appName,
    );

    let secondSameSiteKey = {
      synchronousThrow: false,
      returnsAppCheckForSameApp: false,
    };
    try {
      const handle = appCheckSdk.initializeAppCheck(app, {
        provider: makeProvider('demo-site-key'),
      });
      secondSameSiteKey = {
        synchronousThrow: false,
        returnsAppCheckForSameApp: handle.app === app,
      };
    } catch {
      secondSameSiteKey = {
        synchronousThrow: true,
        returnsAppCheckForSameApp: false,
      };
    }

    const thirdDifferentSiteKey = captureSyncInitializeOutcome(
      () => appCheckSdk.initializeAppCheck(app, { provider: makeProvider('another-site-key') }),
      appName,
    );

    return {
      firstInitialize,
      secondSameSiteKey,
      thirdDifferentSiteKey,
    };
  };

  try {
    delete runtimeGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN;
    const withoutDebugToken = {
      recaptchaV3: runProviderCase((siteKey) => new appCheckSdk.ReCaptchaV3Provider(siteKey)),
      recaptchaEnterprise: runProviderCase(
        (siteKey) => new appCheckSdk.ReCaptchaEnterpriseProvider(siteKey),
      ),
    };

    runtimeGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    const withDebugTokenTrue = {
      recaptchaV3: runProviderCase((siteKey) => new appCheckSdk.ReCaptchaV3Provider(siteKey)),
      recaptchaEnterprise: runProviderCase(
        (siteKey) => new appCheckSdk.ReCaptchaEnterpriseProvider(siteKey),
      ),
    };

    return {
      hasGlobalDocument,
      withoutDebugToken,
      withDebugTokenTrue,
    };
  } finally {
    await Promise.all(createdApps.map((app) => appSdk.deleteApp(app).catch(() => undefined)));
    if (hadDebugToken) {
      runtimeGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN = previousDebugToken;
    } else {
      delete runtimeGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN;
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
    'firebase/app-check initializeAppCheck with ReCaptchaV3Provider and ReCaptchaEnterpriseProvider in a runtime without global document, both with and without FIREBASE_APPCHECK_DEBUG_TOKEN: throws ReferenceError("document is not defined") synchronously after registering the instance, returns the handle on a second call with the same siteKey, and throws appCheck/already-initialized on a different siteKey.',
  async observe() {
    const observed = await observeRecaptchaProvidersWithoutDocument();
    return { ...observed };
  },
};
