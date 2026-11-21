import type { Probe } from '../../rigs/types.ts';

interface StandInElement {
  tagName: string;
  id: string;
  src: string;
  onload: (() => void) | null;
  style: {
    display: string;
  };
}

interface StandInDocument {
  createElement: (tagName: string) => StandInElement;
  body: {
    appendChild: (element: StandInElement) => StandInElement;
  };
  head: {
    appendChild: (element: StandInElement) => StandInElement;
  };
}

type RealmGlobals = {
  FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown;
  document?: unknown;
  self?: unknown;
};

interface SyncThrowOutcome {
  synchronousThrow: boolean;
  name: string | null;
  code: string | null;
  message: string | null;
  customDataMatchesAppName: boolean;
}

interface RecaptchaConstructProviderContract {
  constructsInstance: boolean;
  firstInitialize: {
    synchronousThrow: boolean;
    returnsAppCheckForSameApp: boolean;
    hasAppProperty: boolean;
  };
  secondSameSiteKey: {
    synchronousThrow: boolean;
    returnsSameInstance: boolean;
  };
  thirdDifferentSiteKey: SyncThrowOutcome;
  fourthOtherRecaptchaClassSameSiteKey: SyncThrowOutcome;
}

interface RecaptchaDomInitFacts {
  appendedHiddenDivForApp: boolean;
  appendedRecaptchaScriptSrc: string | null;
}

interface RecaptchaProvidersConstructBehavior {
  hasStandInDocument: boolean;
  providerContract: {
    recaptchaV3: RecaptchaConstructProviderContract;
    recaptchaEnterprise: RecaptchaConstructProviderContract;
  };
  domSideEffects: {
    recaptchaV3: RecaptchaDomInitFacts;
    recaptchaEnterprise: RecaptchaDomInitFacts;
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
    return {
      synchronousThrow: true,
      name,
      code,
      message,
      customDataMatchesAppName: shaped.customData?.appName === expectedAppName,
    };
  }
}

export async function observeRecaptchaProvidersConstruct(): Promise<RecaptchaProvidersConstructBehavior> {
  const [appSdk, appCheckSdk] = await Promise.all([
    import('firebase/app'),
    import('firebase/app-check'),
  ]);
  const realm = globalThis as RealmGlobals;
  const hadDebugToken = Object.prototype.hasOwnProperty.call(
    realm,
    'FIREBASE_APPCHECK_DEBUG_TOKEN',
  );
  const previousDebugToken = realm.FIREBASE_APPCHECK_DEBUG_TOKEN;
  const hadDocument = Object.prototype.hasOwnProperty.call(realm, 'document');
  const previousDocument = realm.document;
  const hadSelf = Object.prototype.hasOwnProperty.call(realm, 'self');
  const previousSelf = realm.self;

  const bodyElements: StandInElement[] = [];
  const headElements: StandInElement[] = [];
  const standInDocument: StandInDocument = {
    createElement(tagName: string): StandInElement {
      return {
        tagName: String(tagName).toUpperCase(),
        id: '',
        src: '',
        onload: null,
        style: { display: '' },
      };
    },
    body: {
      appendChild(element: StandInElement): StandInElement {
        bodyElements.push(element);
        return element;
      },
    },
    head: {
      appendChild(element: StandInElement): StandInElement {
        headElements.push(element);
        return element;
      },
    },
  };

  const createdApps: ReturnType<typeof appSdk.initializeApp>[] = [];
  const options = {
    projectId: 'demo-project',
    apiKey: 'demo-api-key',
    appId: '1:123456789012:web:0a1b2c3d4e5f60718293a4',
  };
  const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let seq = 0;

  try {
    delete realm.FIREBASE_APPCHECK_DEBUG_TOKEN;
    realm.self = globalThis;
    realm.document = standInDocument;
    const hasStandInDocument = typeof realm.document !== 'undefined';

    type RecaptchaInstance =
      | InstanceType<typeof appCheckSdk.ReCaptchaV3Provider>
      | InstanceType<typeof appCheckSdk.ReCaptchaEnterpriseProvider>;

    const runCase = (
      makePrimary: (siteKey: string) => RecaptchaInstance,
      isPrimaryInstance: (candidate: unknown) => boolean,
      makeOtherClass: (siteKey: string) => RecaptchaInstance,
    ): {
      contract: RecaptchaConstructProviderContract;
      dom: RecaptchaDomInitFacts;
    } => {
      seq += 1;
      const appName = `recaptcha-doc-${runSuffix}-${seq}`;
      const app = appSdk.initializeApp(options, appName);
      createdApps.push(app);

      const bodyStart = bodyElements.length;
      const headStart = headElements.length;

      const primary = makePrimary('demo-site-key');
      const constructsInstance = isPrimaryInstance(primary);

      let firstHandle: ReturnType<typeof appCheckSdk.initializeAppCheck> | null = null;
      let firstThrew = false;
      try {
        firstHandle = appCheckSdk.initializeAppCheck(app, {
          provider: primary,
          isTokenAutoRefreshEnabled: false,
        });
      } catch {
        firstThrew = true;
      }

      let returnsAppCheckForSameApp = false;
      let hasAppProperty = false;
      if (firstHandle !== null) {
        returnsAppCheckForSameApp = firstHandle.app === app;
        hasAppProperty = 'app' in firstHandle;
      }

      let secondThrew = false;
      let returnsSameInstance = false;
      try {
        const secondHandle = appCheckSdk.initializeAppCheck(app, {
          provider: makePrimary('demo-site-key'),
          isTokenAutoRefreshEnabled: false,
        });
        returnsSameInstance = secondHandle === firstHandle;
      } catch {
        secondThrew = true;
      }

      const thirdDifferentSiteKey = captureSyncInitializeOutcome(
        () =>
          appCheckSdk.initializeAppCheck(app, {
            provider: makePrimary('another-site-key'),
            isTokenAutoRefreshEnabled: false,
          }),
        appName,
      );
      const fourthOtherRecaptchaClassSameSiteKey = captureSyncInitializeOutcome(
        () =>
          appCheckSdk.initializeAppCheck(app, {
            provider: makeOtherClass('demo-site-key'),
            isTokenAutoRefreshEnabled: false,
          }),
        appName,
      );

      const newBody = bodyElements.slice(bodyStart);
      const newHead = headElements.slice(headStart);
      const appendedHiddenDivForApp = newBody.some(
        (el) =>
          el.tagName === 'DIV' &&
          el.id === `fire_app_check_${appName}` &&
          el.style.display === 'none',
      );
      let appendedRecaptchaScriptSrc: string | null = null;
      const scriptEl = newHead.find((el) => el.tagName === 'SCRIPT');
      if (scriptEl !== undefined) {
        appendedRecaptchaScriptSrc = scriptEl.src;
      }

      return {
        contract: {
          constructsInstance,
          firstInitialize: {
            synchronousThrow: firstThrew,
            returnsAppCheckForSameApp,
            hasAppProperty,
          },
          secondSameSiteKey: {
            synchronousThrow: secondThrew,
            returnsSameInstance,
          },
          thirdDifferentSiteKey,
          fourthOtherRecaptchaClassSameSiteKey,
        },
        dom: {
          appendedHiddenDivForApp,
          appendedRecaptchaScriptSrc,
        },
      };
    };

    const v3Outcome = runCase(
      (siteKey) => new appCheckSdk.ReCaptchaV3Provider(siteKey),
      (candidate) => candidate instanceof appCheckSdk.ReCaptchaV3Provider,
      (siteKey) => new appCheckSdk.ReCaptchaEnterpriseProvider(siteKey),
    );
    const enterpriseOutcome = runCase(
      (siteKey) => new appCheckSdk.ReCaptchaEnterpriseProvider(siteKey),
      (candidate) => candidate instanceof appCheckSdk.ReCaptchaEnterpriseProvider,
      (siteKey) => new appCheckSdk.ReCaptchaV3Provider(siteKey),
    );

    return {
      hasStandInDocument,
      providerContract: {
        recaptchaV3: v3Outcome.contract,
        recaptchaEnterprise: enterpriseOutcome.contract,
      },
      domSideEffects: {
        recaptchaV3: v3Outcome.dom,
        recaptchaEnterprise: enterpriseOutcome.dom,
      },
    };
  } finally {
    await Promise.all(createdApps.map((app) => appSdk.deleteApp(app).catch(() => undefined)));
    if (hadDocument) {
      realm.document = previousDocument;
    } else {
      delete realm.document;
    }
    if (hadSelf) {
      realm.self = previousSelf;
    } else {
      delete realm.self;
    }
    if (hadDebugToken) {
      realm.FIREBASE_APPCHECK_DEBUG_TOKEN = previousDebugToken;
    } else {
      delete realm.FIREBASE_APPCHECK_DEBUG_TOKEN;
    }
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  matrixRow: 'app-check#recaptcha-providers-construct',
  rowIds: ['app-check#recaptcha-providers-construct'],
  description:
    'firebase/app-check ReCaptchaV3Provider and ReCaptchaEnterpriseProvider in a realm with global document: construct from a siteKey, return the AppCheck handle from initializeAppCheck, return the identical handle on a second call with equal options, and throw appCheck/already-initialized on a different siteKey or provider class.',
  async observe() {
    const observed = await observeRecaptchaProvidersConstruct();
    return { ...observed };
  },
};
