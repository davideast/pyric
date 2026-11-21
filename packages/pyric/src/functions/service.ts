/**
 * `FunctionsService` and factory functions (`getFunctions`, `httpsCallable`,
 * `httpsCallableFromURL`, `connectFunctionsEmulator`), matching
 * `@firebase/functions` 0.14.0.
 */
import '../app/runtime.js';
import type { FirebaseApp } from '../app/types.js';
import { appCheckTokenFor } from '../sandbox/internal/app-check-activation.js';
import {
  defaultClientApp,
  resolveClientApp,
  type ClientAppRuntime,
} from '../sandbox/internal/client-app.js';
import { mintIdToken } from '../sandbox/internal/id-token.js';
import {
  executeCallable,
  type CallableExecutionContext,
  type FunctionsFetch,
} from './call.js';
import { executeCallableStream } from './stream.js';
import type {
  Functions,
  HttpsCallable,
  HttpsCallableOptions,
  HttpsCallableStreamOptions,
} from './types.js';
import {
  DEFAULT_REGION,
  parseRegionOrCustomDomain,
  resolveNamedCallableTarget,
  resolveUrlCallableTarget,
  type ResolvedCallableTarget,
} from './url.js';

export interface FunctionsHostTransport {
  gatewayOrigin(): Promise<string | null>;
  authToken(app: FirebaseApp): Promise<string | null>;
  fetchImpl: FunctionsFetch;
}

const FUNCTIONS_INSTANCE_TAG = Symbol('pyric.functions.instance');

interface InternalFunctions extends Functions {
  readonly [FUNCTIONS_INSTANCE_TAG]: true;
  readonly projectId: string;
  readonly transport: FunctionsHostTransport;
  readonly cancelAllRequests: Promise<void>;
}

function defaultGatewayOrigin(): Promise<string | null> {
  if (typeof location !== 'undefined' && typeof location.origin === 'string' && location.origin.startsWith('http')) {
    return Promise.resolve(location.origin);
  }
  return Promise.resolve(null);
}

export function inProcessAuthToken(app: FirebaseApp): Promise<string | null> {
  const runtime = resolveClientApp(app);
  if (!runtime) {
    return Promise.resolve(null);
  }
  try {
    const current = runtime.session.currentUser;
    if (!current || !current.token) {
      return Promise.resolve(null);
    }
    return Promise.resolve(mintIdToken(current.token));
  } catch {
    return Promise.resolve(null);
  }
}

const DEFAULT_TRANSPORT: FunctionsHostTransport = {
  gatewayOrigin: defaultGatewayOrigin,
  authToken: inProcessAuthToken,
  fetchImpl: (input, init) => fetch(input, init),
};

function requireRuntime(app: FirebaseApp): ClientAppRuntime {
  const runtime = resolveClientApp(app);
  if (!runtime) {
    throw new TypeError('pyric/functions: unrecognized FirebaseApp handle.');
  }
  return runtime;
}

function requireInternalFunctions(value: Functions): InternalFunctions {
  if (
    typeof value === 'object' &&
    value !== null &&
    FUNCTIONS_INSTANCE_TAG in value
  ) {
    return value as InternalFunctions;
  }
  throw new TypeError('pyric/functions: expected a Functions instance from getFunctions().');
}

async function buildCallableHeaders(
  instance: InternalFunctions,
  limitedUseAppCheckTokens: boolean | undefined,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  try {
    const idToken = await instance.transport.authToken(instance.app);
    if (idToken) {
      headers.Authorization = `Bearer ${idToken}`;
    }
  } catch {
    // Upstream leaves Authorization off if auth token retrieval fails.
  }

  const limitedUse = limitedUseAppCheckTokens === true;
  try {
    const appCheckToken = await appCheckTokenFor(instance.app, { limitedUse });
    if (appCheckToken !== null) {
      headers['X-Firebase-AppCheck'] = appCheckToken;
    }
  } catch (err: unknown) {
    // Upstream propagates getLimitedUseToken rejections; regular getToken resolves placeholder in state.ts.
    if (limitedUse) {
      throw err;
    }
  }
  return headers;
}

function makeExecutionContext(
  instance: InternalFunctions,
  resolveTarget: () => Promise<ResolvedCallableTarget>,
): CallableExecutionContext {
  return {
    resolveTarget,
    buildHeaders: (limitedUse) => buildCallableHeaders(instance, limitedUse),
    fetchImpl: instance.transport.fetchImpl,
    cancelAllRequests: instance.cancelAllRequests,
  };
}

/**
 * Creates a `getFunctions` factory bound to a specific host transport (used by
 * `@pyric/cli`'s served page and Node-host entries).
 */
export function createGetFunctions(
  transport: FunctionsHostTransport,
  cacheNamespace: string,
): (app?: FirebaseApp, regionOrCustomDomain?: string) => Functions {
  return (rawApp?: FirebaseApp, regionOrCustomDomain: string = DEFAULT_REGION): Functions => {
    let app = rawApp;
    if (app === undefined) {
      app = defaultClientApp() as FirebaseApp;
    }
    const runtime = requireRuntime(app);
    const serviceKey = `${cacheNamespace}:${regionOrCustomDomain}`;
    return runtime.service<InternalFunctions>(serviceKey, () => {
      const parsed = parseRegionOrCustomDomain(regionOrCustomDomain);
      let resolveCancel: () => void = () => {};
      const cancelAllRequests = new Promise<void>((resolve) => {
        resolveCancel = resolve;
      });
      runtime.onDelete(() => {
        resolveCancel();
      });
      let projectId = '';
      if (typeof runtime.options?.projectId === 'string') {
        projectId = runtime.options.projectId;
      }
      return {
        [FUNCTIONS_INSTANCE_TAG]: true,
        app,
        region: parsed.region,
        customDomain: parsed.customDomain,
        projectId,
        transport,
        cancelAllRequests,
      };
    });
  };
}

/**
 * Returns a {@link Functions} instance for `app` and `regionOrCustomDomain`.
 */
export const getFunctions = createGetFunctions(DEFAULT_TRANSPORT, 'functions');

let warnedEmulator = false;

/**
 * Accepts `connectFunctionsEmulator` as a compatibility no-op while keeping
 * requests routed through Pyric's gateway, logging one warning per realm
 * (`functions-callable#24`, plan decision 5).
 */
export function connectFunctionsEmulator(
  functionsInstance: Functions,
  host: string,
  port: number,
): void {
  requireInternalFunctions(functionsInstance);
  if (!warnedEmulator) {
    warnedEmulator = true;
    console.warn(
      `[pyric] connectFunctionsEmulator(${host}, ${port}) ignored: callable functions already route through the pyric gateway.`,
    );
  }
}

/**
 * Resets the once-per-realm `connectFunctionsEmulator` warning flag in unit tests.
 */
export function resetConnectFunctionsEmulatorWarningForTests(): void {
  warnedEmulator = false;
}

/**
 * Returns a callable reference for the named HTTPS callable trigger.
 */
export function httpsCallable<
  RequestData = unknown,
  ResponseData = unknown,
  StreamData = unknown,
>(
  functionsInstance: Functions,
  name: string,
  options?: HttpsCallableOptions,
): HttpsCallable<RequestData, ResponseData, StreamData> {
  const internal = requireInternalFunctions(functionsInstance);
  let baseOptions: HttpsCallableOptions = {};
  if (options !== undefined) {
    baseOptions = options;
  }
  const context = makeExecutionContext(internal, async () =>
    resolveNamedCallableTarget({
      projectId: internal.projectId,
      region: internal.region,
      customDomain: internal.customDomain,
      name,
      gatewayOrigin: await internal.transport.gatewayOrigin(),
    }),
  );

  const callable = ((data?: RequestData | null) =>
    executeCallable<RequestData, ResponseData>(context, data, baseOptions)) as HttpsCallable<
    RequestData,
    ResponseData,
    StreamData
  >;

  callable.stream = (
    data?: RequestData | null,
    streamOptions?: HttpsCallableStreamOptions,
  ) => {
    let resolvedStreamOptions: HttpsCallableStreamOptions = {};
    if (baseOptions.limitedUseAppCheckTokens !== undefined) {
      resolvedStreamOptions = { limitedUseAppCheckTokens: baseOptions.limitedUseAppCheckTokens };
    }
    if (streamOptions !== undefined) {
      resolvedStreamOptions = { ...resolvedStreamOptions, ...streamOptions };
    }
    return executeCallableStream<RequestData, ResponseData, StreamData>(
      context,
      data,
      resolvedStreamOptions,
    );
  };

  return callable;
}

/**
 * Returns a callable reference targeting `url` (`cloudfunctions.net`, `run.app`,
 * or the local gateway origin; any off-machine URL is refused).
 */
export function httpsCallableFromURL<
  RequestData = unknown,
  ResponseData = unknown,
  StreamData = unknown,
>(
  functionsInstance: Functions,
  url: string,
  options?: HttpsCallableOptions,
): HttpsCallable<RequestData, ResponseData, StreamData> {
  const internal = requireInternalFunctions(functionsInstance);
  let baseOptions: HttpsCallableOptions = {};
  if (options !== undefined) {
    baseOptions = options;
  }
  const context = makeExecutionContext(internal, async () =>
    resolveUrlCallableTarget({
      projectId: internal.projectId,
      region: internal.region,
      rawUrl: url,
      gatewayOrigin: await internal.transport.gatewayOrigin(),
    }),
  );

  const callable = ((data?: RequestData | null) =>
    executeCallable<RequestData, ResponseData>(context, data, baseOptions)) as HttpsCallable<
    RequestData,
    ResponseData,
    StreamData
  >;

  callable.stream = (
    data?: RequestData | null,
    streamOptions?: HttpsCallableStreamOptions,
  ) => {
    let resolvedStreamOptions: HttpsCallableStreamOptions = {};
    if (baseOptions.limitedUseAppCheckTokens !== undefined) {
      resolvedStreamOptions = { limitedUseAppCheckTokens: baseOptions.limitedUseAppCheckTokens };
    }
    if (streamOptions !== undefined) {
      resolvedStreamOptions = { ...resolvedStreamOptions, ...streamOptions };
    }
    return executeCallableStream<RequestData, ResponseData, StreamData>(
      context,
      data,
      resolvedStreamOptions,
    );
  };

  return callable;
}
