/**
 * Self-contained browser ESM probe program executed against isolated
 * `firebase@13.4.0` (`@firebase/crashlytics@0.2.0`) with `globalThis.fetch`
 * stubbed locally for zero network egress.
 */

export function buildCrashlyticsWebBrowserProbeSource(): string {
  return `
const capturedRequests = [];

function isAllowedStubbedTelemetryUrl(url) {
  if (url === 'https://clienttelemetry.googleapis.com/v1/logs') {
    return true;
  }
  if (/^https:\\/\\/clienttelemetry\\.[a-z0-9-]+\\.rep\\.googleapis\\.com\\/v1\\/logs$/.test(url)) {
    return true;
  }
  if (url === 'http://127.0.0.1:4318/v1/logs') {
    return true;
  }
  return false;
}

globalThis.fetch = async (url, init) => {
  const urlString = String(url);
  if (!isAllowedStubbedTelemetryUrl(urlString)) {
    throw new Error('Refused unexpected outbound URL in offline Crashlytics probe: ' + urlString);
  }
  const rawBody = init && init.body;
  let bodyText = '';
  if (rawBody instanceof Uint8Array || ArrayBuffer.isView(rawBody)) {
    bodyText = new TextDecoder().decode(rawBody);
  } else if (typeof rawBody === 'string') {
    bodyText = rawBody;
  }
  const headersObj = {};
  if (init && init.headers) {
    new Headers(init.headers).forEach((value, key) => {
      headersObj[key.toLowerCase()] = value;
    });
  }
  let parsedBody = null;
  if (bodyText.length > 0) {
    parsedBody = JSON.parse(bodyText);
  }
  capturedRequests.push({
    url: urlString,
    method: (init && init.method) || 'GET',
    headers: headersObj,
    keepalive: Boolean(init && init.keepalive),
    body: parsedBody,
  });
  return new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

function installBrowserDomEnvironment(initialVisibility) {
  const windowListeners = new Map();
  const documentListeners = new Map();
  const storageMap = new Map();

  class StubXMLHttpRequest {
    open() {}
    send() {}
    setRequestHeader() {}
    addEventListener() {}
    removeEventListener() {}
  }

  const docTarget = {
    visibilityState: initialVisibility,
    readyState: 'loading',
    addEventListener(type, fn) {
      let bucket = documentListeners.get(type);
      if (!bucket) {
        bucket = new Set();
        documentListeners.set(type, bucket);
      }
      bucket.add(fn);
    },
    removeEventListener(type, fn) {
      const bucket = documentListeners.get(type);
      if (bucket) {
        bucket.delete(fn);
      }
    },
  };

  const winTarget = {
    location: {
      hostname: 'localhost',
      pathname: '/checkout',
      href: 'http://localhost/checkout',
    },
    document: docTarget,
    navigator: { userAgent: 'PyricOfflineProbe/1.0' },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener(type, fn) {
      let bucket = windowListeners.get(type);
      if (!bucket) {
        bucket = new Set();
        windowListeners.set(type, bucket);
      }
      bucket.add(fn);
    },
    removeEventListener(type, fn) {
      const bucket = windowListeners.get(type);
      if (bucket) {
        bucket.delete(fn);
      }
    },
  };

  globalThis.XMLHttpRequest = StubXMLHttpRequest;
  globalThis.sessionStorage = {
    getItem(key) {
      if (storageMap.has(key)) {
        return storageMap.get(key);
      }
      return null;
    },
    setItem(key, value) {
      storageMap.set(key, String(value));
    },
  };
  globalThis.document = docTarget;
  globalThis.window = winTarget;

  return {
    windowListeners,
    documentListeners,
    storageMap,
    docTarget,
    async dispatchWindow(type, event) {
      const bucket = windowListeners.get(type);
      if (!bucket) {
        return;
      }
      for (const listener of [...bucket]) {
        await listener(event);
      }
    },
    listenerCounts() {
      const counts = {};
      for (const [key, set] of windowListeners.entries()) {
        counts[key] = set.size;
      }
      return counts;
    },
    restore() {
      delete globalThis.window;
      delete globalThis.document;
      delete globalThis.sessionStorage;
      delete globalThis.XMLHttpRequest;
    },
  };
}

const { initializeApp, deleteApp } = await import('firebase/app');
const {
  getCrashlytics,
  breadcrumbs,
  log,
  recordError,
  flush,
} = await import('firebase/crashlytics');
const { logs: otelLogs } = await import('@opentelemetry/api');

function drainRequests() {
  const items = capturedRequests.slice();
  capturedRequests.length = 0;
  return items;
}

// 1. Instance scoping, breadcrumbs() descriptor, and getCrashlytics options contract
const instanceContract = await (async () => {
  const defaultApp = initializeApp({
    apiKey: 'probe-api-key-default',
    projectId: 'demo-crashlytics-default',
    appId: '1:100:web:default01',
  });
  const namedApp = initializeApp(
    {
      apiKey: 'probe-api-key-named',
      projectId: 'demo-crashlytics-named',
      appId: '1:100:web:named02',
    },
    'secondary-app',
  );

  const crumbFeature = breadcrumbs();
  const breadcrumbFeatureKeys = Object.keys(crumbFeature);
  const breadcrumbFeatureName = crumbFeature.name;

  const defaultInstance = getCrashlytics();
  const defaultSameEmpty = getCrashlytics(defaultApp, {}) === defaultInstance;
  const defaultSameOmitted = getCrashlytics(defaultApp) === defaultInstance;

  const configuredOpts = {
    appVersion: '2.4.1',
    region: 'europe-west1',
    customAttributes: { env: 'staging', tier: 'pro' },
    features: [breadcrumbs()],
  };
  const namedInstance = getCrashlytics(namedApp, configuredOpts);
  const namedSameOptions =
    getCrashlytics(namedApp, {
      appVersion: '2.4.1',
      region: 'europe-west1',
      customAttributes: { tier: 'pro', env: 'staging' },
      features: [breadcrumbs()],
    }) === namedInstance;

  let omittedAfterOptionsError = null;
  try {
    getCrashlytics(namedApp);
  } catch (err) {
    omittedAfterOptionsError = err instanceof Error ? err.message : String(err);
  }

  let mismatchedOptionsError = null;
  try {
    getCrashlytics(namedApp, { appVersion: '9.9.9' });
  } catch (err) {
    mismatchedOptionsError = err instanceof Error ? err.message : String(err);
  }

  const distinctAppsIsolated = defaultInstance !== namedInstance && namedInstance.app === namedApp;
  await deleteApp(defaultApp);
  await deleteApp(namedApp);
  drainRequests();

  return {
    breadcrumbFeatureKeys,
    breadcrumbFeatureName,
    defaultSameEmpty,
    defaultSameOmitted,
    namedSameOptions,
    distinctAppsIsolated,
    omittedAfterOptionsError,
    mismatchedOptionsError,
  };
})();

// 2. OTLP endpoints, region, endpointUrl, appVersion, customAttributes, registerGlobalLoggerProvider
const otlpOptionsContract = await (async () => {
  drainRequests();
  const globalApp = initializeApp(
    {
      apiKey: 'probe-key-global',
      projectId: 'demo-otlp-global',
      appId: '1:200:web:globalotlp',
    },
    'otlp-global-app',
  );
  const beforeGlobalProvider = otelLogs.getLoggerProvider();
  const globalCrashlytics = getCrashlytics(globalApp, {
    customAttributes: { env: 'dev', tier: 'base' },
  });
  const defaultLeavesGlobalProviderUnchanged =
    otelLogs.getLoggerProvider() === beforeGlobalProvider;
  log(globalCrashlytics, 'global-log-entry', {
    tier: 'override-log',
    tags: ['alpha', 'beta'],
  });
  await flush(globalCrashlytics);
  const globalRequests = drainRequests();
  await deleteApp(globalApp);

  const regionalApp = initializeApp(
    {
      apiKey: 'probe-key-regional',
      projectId: 'demo-otlp-regional',
      appId: '1:200:web:regionalotlp',
    },
    'otlp-regional-app',
  );
  const regionalCrashlytics = getCrashlytics(regionalApp, {
    region: 'europe-west1',
    appVersion: '2.4.1',
    customAttributes: { env: 'prod', shared: 'from-options' },
  });
  const missingStackErr = new TypeError('regional-type-failure');
  missingStackErr.stack = '';
  recordError(regionalCrashlytics, missingStackErr, {
    shared: 'from-call',
    attempt: 3,
  });
  recordError(regionalCrashlytics, 'plain-string-error');
  recordError(regionalCrashlytics, { code: 503 });
  recordError(regionalCrashlytics, 42);
  await flush(regionalCrashlytics);
  const regionalRequests = drainRequests();
  await deleteApp(regionalApp);

  const customEpApp = initializeApp(
    {
      apiKey: 'probe-key-custom',
      projectId: 'demo-otlp-custom',
      appId: '1:200:web:customotlp',
    },
    'otlp-custom-app',
  );
  const beforeRegisteredProvider = otelLogs.getLoggerProvider();
  const customCrashlytics = getCrashlytics(customEpApp, {
    endpointUrl: 'http://127.0.0.1:4318///',
    region: 'us-east1',
    appVersion: '5.0.0',
    registerGlobalLoggerProvider: true,
  });
  const globalProviderRegistered = otelLogs.getLoggerProvider() !== beforeRegisteredProvider;
  otelLogs.getLogger('external-otel-scope').emit({
    body: 'emitted-through-global-provider',
  });
  await flush(customCrashlytics);
  const customEndpointRequests = drainRequests();
  otelLogs.disable();
  await deleteApp(customEpApp);

  return {
    defaultLeavesGlobalProviderUnchanged,
    globalProviderRegistered,
    globalRequests,
    regionalRequests,
    customEndpointRequests,
  };
})();

// 3. Browser breadcrumbs buffering, clearing after recordError, visibility, unhandled errors, deduplication, deleteApp
const browserLifecycleContract = await (async () => {
  drainRequests();
  const dom = installBrowserDomEnvironment('visible');
  try {
    const app = initializeApp(
      {
        apiKey: 'probe-key-browser',
        projectId: 'demo-browser-lifecycle',
        appId: '1:300:web:browser01',
      },
      'browser-lifecycle-app',
    );
    const crashlytics = getCrashlytics(app, {
      appVersion: '3.1.0',
      customAttributes: { surface: 'checkout' },
      features: [breadcrumbs()],
    });
    const listenersWhenActive = dom.listenerCounts();

    log(crashlytics, 'crumb-one', { step: 1 });
    await dom.dispatchWindow('visibilitychange', {});
    await flush(crashlytics);
    const requestCountBeforeError = drainRequests().length;

    const boundaryErr = new Error('caught-and-rethrown-error');
    recordError(crashlytics, boundaryErr, { handled: true });
    await dom.dispatchWindow('error', { error: boundaryErr });
    await dom.dispatchWindow('unhandledrejection', {
      reason: new RangeError('unhandled-rejection-boom'),
    });
    await flush(crashlytics);
    const firstErrorBatch = drainRequests();

    log(crashlytics, 'crumb-after-first-error', { step: 2 });
    recordError(crashlytics, new Error('second-distinct-error'));
    // Trigger auto-flush via visibilitychange -> hidden (without manual flush call)
    dom.docTarget.visibilityState = 'hidden';
    await dom.dispatchWindow('visibilitychange', {});
    const secondErrorAutoFlushedBatch = drainRequests();

    await deleteApp(app);
    const listenersAfterDelete = dom.listenerCounts();

    log(crashlytics, 'post-delete-log');
    recordError(crashlytics, new Error('post-delete-error'));
    await flush(crashlytics);
    const requestCountOnShutDownHandle = drainRequests().length;

    const freshDeletedApp = initializeApp(
      {
        apiKey: 'probe-key-deleted',
        projectId: 'demo-deleted',
        appId: '1:300:web:deleted02',
      },
      'fresh-deleted-app',
    );
    await deleteApp(freshDeletedApp);
    let getCrashlyticsOnFreshDeletedCode = null;
    try {
      getCrashlytics(freshDeletedApp);
    } catch (err) {
      getCrashlyticsOnFreshDeletedCode = err && err.code ? String(err.code) : String(err);
    }

    const disabledUnhandledApp = initializeApp(
      {
        apiKey: 'probe-key-disabled-unhandled',
        projectId: 'demo-disabled-unhandled',
        appId: '1:300:web:disabled03',
      },
      'disabled-unhandled-app',
    );
    getCrashlytics(disabledUnhandledApp, { captureUnhandledErrors: false });
    const listenersWhenUnhandledDisabled = dom.listenerCounts();
    await deleteApp(disabledUnhandledApp);
    drainRequests();

    return {
      sessionIdStored: Boolean(dom.storageMap.get('firebasecrashlytics.sessionid')),
      listenersWhenActive,
      requestCountBeforeError,
      firstErrorBatch,
      secondErrorAutoFlushedBatch,
      listenersAfterDelete,
      requestCountOnShutDownHandle,
      getCrashlyticsOnFreshDeletedCode,
      listenersWhenUnhandledDisabled,
    };
  } finally {
    dom.restore();
  }
})();

console.log(
  JSON.stringify({
    __crashlyticsProbeResult: true,
    data: {
      instanceContract,
      otlpOptionsContract,
      browserLifecycleContract,
    },
  }),
);
`;
}
