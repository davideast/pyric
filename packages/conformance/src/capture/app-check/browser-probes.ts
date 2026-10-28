/**
 * Client-plane App Check captures in headless Chromium: the real
 * `firebase/app-check` in debug mode, and the `X-Firebase-AppCheck` header the
 * real `firebase/ai` SDK attaches to generateContent. AI requests are observed
 * with a Playwright route and continued to production unchanged.
 */
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { APP_CHECK_BROWSER_SOURCE } from './browser-source.ts';
import { jwtShape, redactText, type Secrets } from './redact.ts';
import { writeObservation, type ObservationContext } from './observation-writer.ts';

interface CapturedRequest {
  path: string;
  headerNames: string[];
  appCheckHeader: string | null;
  responseStatus: number | null;
  responseBody: unknown;
}

/** The placeholder the web SDK substitutes when attestation fails: base64 of {"error":"UNKNOWN_ERROR"}. */
const SDK_DUMMY_TOKEN = Buffer.from(JSON.stringify({ error: 'UNKNOWN_ERROR' })).toString('base64');

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { nonJsonLength: text.length };
  }
}

interface Facts {
  keySet: string[];
  token: string | null;
  error: Record<string, unknown> | null;
  internalError: Record<string, unknown> | null;
  threw?: boolean;
}

export interface BrowserProbeInput {
  context: ObservationContext;
  firebaseConfig: Record<string, unknown>;
  debugToken: string;
  unregisteredDebugToken: string;
  /** When set, only these standalone probes run; the main flow and every AI request are skipped. */
  only?: string[];
}

/** Browser probes that run on their own, without the main flow. The ones that send an AI request are AI_REQUEST_BROWSER_PROBES (enforcement-guard.ts). */
export const STANDALONE_BROWSER_PROBES = [
  'app-check-client-initialize-twice',
  'app-check-client-initialize-twice-unset-auto-refresh',
  'app-check-client-get-token-concurrent',
  'app-check-client-get-token-before-initialize',
] as const;

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: ['virtual:app-check-probe'],
    target: 'browser',
    format: 'iife',
    plugins: [{
      name: 'app-check-probe',
      setup(builder) {
        builder.onResolve({ filter: /^virtual:app-check-probe$/ }, () => ({ path: 'app-check-probe.js', namespace: 'app-check' }));
        builder.onLoad({ filter: /.*/, namespace: 'app-check' }, () => ({ contents: APP_CHECK_BROWSER_SOURCE, loader: 'js' }));
      },
    }],
  });
  if (!built.success) throw new Error(`browser bundle failed: ${built.logs.map((log) => log.message).join('; ')}`);
  return built.outputs[0]!.text();
}

async function openPage(
  context: BrowserContext,
  origin: string,
  debugToken: string,
  captured: CapturedRequest[],
  secrets: Secrets,
): Promise<Page> {
  await context.addInitScript((token) => {
    (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string }).FIREBASE_APPCHECK_DEBUG_TOKEN = token;
  }, debugToken);
  await context.route('https://firebasevertexai.googleapis.com/**', async (route) => {
    const headers = route.request().headers();
    if (headers['x-firebase-appcheck']) secrets.values.push(headers['x-firebase-appcheck']);
    const entry: CapturedRequest = {
      path: new URL(route.request().url()).pathname,
      headerNames: Object.keys(headers).map((name) => name.toLowerCase()).sort(),
      appCheckHeader: headers['x-firebase-appcheck'] ?? null,
      responseStatus: null,
      responseBody: null,
    };
    captured.push(entry);
    const response = await route.fetch();
    const text = await response.text();
    entry.responseStatus = response.status();
    entry.responseBody = entry.responseStatus === 200 ? { ok: true } : parseBody(text);
    await route.fulfill({ response, body: text });
  });
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => typeof (globalThis as { appCheckProbes?: unknown }).appCheckProbes === 'object');
  return page;
}

function call<T>(page: Page, method: string, config: Record<string, unknown>): Promise<T> {
  return page.evaluate(
    ([name, firebaseConfig]) => (globalThis as unknown as { appCheckProbes: Record<string, (c: unknown) => Promise<unknown>> })
      .appCheckProbes[name as string]!(firebaseConfig),
    [method, config] as const,
  ) as Promise<T>;
}

export async function runBrowserProbes(input: BrowserProbeInput, failures: string[]): Promise<void> {
  const { context, firebaseConfig } = input;
  const secrets: Secrets = context.secrets;
  const script = await bundle();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/probe.js') return new Response(script, { headers: { 'content-type': 'text/javascript' } });
      return new Response('<!doctype html><script src="/probe.js"></script>', { headers: { 'content-type': 'text/html' } });
    },
  });
  const origin = `http://localhost:${server.port}`;
  const browser = await chromium.launch({ headless: true });
  const remember = (facts: Facts) => {
    if (facts.token) secrets.values.push(facts.token);
    return facts;
  };
  const shape = (facts: Facts) => ({
    keySet: facts.keySet,
    token: facts.token ? jwtShape(facts.token, secrets) : null,
    error: facts.error,
    internalError: facts.internalError,
  });
  const headerFacts = (request: CapturedRequest | undefined, compareTo: Record<string, string | null>) => ({
    requestSeen: request !== undefined,
    path: request ? redactText(request.path, secrets) : null,
    headerNames: request?.headerNames ?? [],
    appCheckHeaderPresent: Boolean(request?.appCheckHeader),
    appCheckHeaderShape: request?.appCheckHeader ? jwtShape(request.appCheckHeader, secrets) : null,
    appCheckHeaderIsSdkDummyToken: request?.appCheckHeader === SDK_DUMMY_TOKEN,
    responseStatus: request?.responseStatus ?? null,
    responseBody: request?.responseBody ?? null,
    appCheckHeaderEquals: Object.fromEntries(
      Object.entries(compareTo).map(([label, token]) => [label, Boolean(token) && request?.appCheckHeader === token]),
    ),
  });
  const probe = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      failures.push(name);
      console.error(`failed ${name}: ${redactText(String(error), secrets)}`);
    }
  };

  const wanted = (name: string) => !input.only || input.only.includes(name);

  try {
    const validCaptured: CapturedRequest[] = [];
    const valid = await openPage(await browser.newContext(), origin, input.debugToken, validCaptured, secrets);

    if (wanted('app-check-client-initialize-twice')) await probe('app-check-client-initialize-twice', async () => {
      const behavior = await call<Record<string, unknown>>(valid, 'initializeTwice', firebaseConfig);
      writeObservation(context, 'app-check-client-initialize-twice',
        'initializeAppCheck called a second time on the same app: with identical options (same provider instance), with a new provider instance built from the same factory, and with a different isTokenAutoRefreshEnabled.',
        behavior, 'client');
    });

    if (wanted('app-check-client-initialize-twice-unset-auto-refresh')) await probe('app-check-client-initialize-twice-unset-auto-refresh', async () => {
      const behavior = await call<Record<string, unknown>>(valid, 'initializeTwiceUnsetAutoRefresh', firebaseConfig);
      writeObservation(context, 'app-check-client-initialize-twice-unset-auto-refresh',
        'initializeAppCheck called a second time on the same app with the same provider instance, where one of the two calls omits isTokenAutoRefreshEnabled: omitted then false, false then omitted, and omitted both times.',
        behavior, 'client');
    });

    if (wanted('app-check-client-get-token-concurrent')) await probe('app-check-client-get-token-concurrent', async () => {
      const behavior = await call<Record<string, unknown>>(valid, 'concurrentGetToken', firebaseConfig);
      const tokens = ['firstA', 'firstB', 'forcedA', 'forcedB'].map((key) => remember(behavior[key] as Facts));
      const [firstA, firstB, forcedA, forcedB] = tokens as [Facts, Facts, Facts, Facts];
      const listenerTokens = behavior.listenerTokens as string[];
      secrets.values.push(...listenerTokens);
      writeObservation(context, 'app-check-client-get-token-concurrent',
        'Debug mode only (registered debug token): two getToken calls started together with no cached token, then two getToken(appCheck, true) calls started together, with a listener registered before the first pair. Records whether each pair resolved to one token, whether the forced pair differs from the first, and the listener call count read 300 ms after each pair.',
        {
          customProviderCalls: behavior.providerCalls,
          first: shape(firstA),
          concurrentFirstShareOneToken: firstA.token !== null && firstB.token === firstA.token,
          forced: shape(forcedA),
          concurrentForcedShareOneToken: forcedA.token !== null && forcedB.token === forcedA.token,
          forcedDiffersFromFirst: forcedA.token !== firstA.token,
          listenerCallsAfterConcurrentFirst: behavior.listenerCallsAfterConcurrentFirst,
          listenerCallsAfterConcurrentForced: behavior.listenerCallsAfterConcurrentForced,
        }, 'client');
    });

    if (wanted('app-check-client-get-token-before-initialize')) await probe('app-check-client-get-token-before-initialize', async () => {
      validCaptured.length = 0;
      const behavior = await call<Record<string, unknown>>(valid, 'beforeInitialize', firebaseConfig);
      const late = behavior.getTokenAfterLateInitialize as Facts | null;
      if (late?.token) remember(late);
      writeObservation(context, 'app-check-client-get-token-before-initialize',
        'Public getToken passed an object whose app never called initializeAppCheck, and initializeAppCheck called after firebase/ai already built a model on the app, followed by getToken and one generateContent whose X-Firebase-AppCheck header is recorded.',
        {
          ...behavior,
          getTokenAfterLateInitialize: late && 'keySet' in late ? shape(late) : late,
          aiRequestAfterLateInitialize: headerFacts(validCaptured[0], { lateGetToken: late?.token ?? null }),
        }, 'client');
    });

    if (input.only) return;

    validCaptured.length = 0;
    const main = await call<Record<string, unknown>>(valid, 'mainFlow', firebaseConfig);
    const first = remember(main.first as Facts);
    const second = remember(main.second as Facts);
    const forced = remember(main.forced as Facts);
    const limitedA = remember(main.limitedA as Facts);
    const limitedB = remember(main.limitedB as Facts);
    const cachedAfterLimited = remember(main.cachedAfterLimited as Facts);
    const forcedAfterUnsubscribe = remember(main.forcedAfterUnsubscribe as Facts);
    const limitedAppCached = remember(main.limitedAppCachedToken as Facts);
    const afterToggle = remember(main.afterToggle as Facts);
    const listener = main.listener as { tokens: string[]; [key: string]: unknown };
    const observer = main.observer as { tokens: string[]; callsTotal: number };
    const late = main.listenerRegisteredAfterTokenExists as { tokens: string[]; callsSynchronous: number; callsWithin500ms: number };
    secrets.values.push(...listener.tokens, ...observer.tokens, ...late.tokens);
    const [generationRequest, limitedRequest, plainRequest] = validCaptured;

    await probe('app-check-client-debug-get-token', async () => {
      writeObservation(context, 'app-check-client-debug-get-token',
        'getToken in debug mode with a registered debug token and a CustomProvider that must not be called: result key set, token shape, whether a second getToken reuses the cached token, and whether getToken(appCheck, true) mints a new one.',
        {
          customProviderCalls: main.providerCalls,
          first: shape(first),
          secondEqualsFirst: second.token === first.token,
          forceRefreshDiffersFromFirst: forced.token !== first.token,
          forced: shape(forced),
        }, 'client');
    });

    await probe('app-check-client-limited-use-token', async () => {
      writeObservation(context, 'app-check-client-limited-use-token',
        'getLimitedUseToken in debug mode: result key set and token shape, whether it differs from the cached getToken token, and whether two calls return distinct tokens.',
        {
          limited: shape(limitedA),
          differsFromCachedToken: limitedA.token !== forced.token,
          twoCallsDistinct: limitedA.token !== limitedB.token,
          cachedTokenAfterLimitedUseUnchanged: cachedAfterLimited.token === forced.token,
        }, 'client');
    });

    await probe('app-check-client-on-token-changed', async () => {
      const tokenLabels = (tokens: string[]) => tokens.map((token) => {
        if (token === first.token) return 'first';
        if (token === forced.token) return 'forced';
        if (token === forcedAfterUnsubscribe.token) return 'forcedAfterUnsubscribe';
        if (token === limitedA.token || token === limitedB.token) return 'limited';
        return 'other';
      });
      writeObservation(context, 'app-check-client-on-token-changed',
        'Debug mode only (registered debug token): onTokenChanged with a listener function and with an observer object, registered before the first getToken. Counts are read 300 ms after each step: after the first get, after a second get, after a forced refresh, after two getLimitedUseToken calls, and after unsubscribing and forcing again; argument key sets; which token each call carried; and a listener registered after a token exists (synchronously and within 500 ms).',
        {
          unsubscribeType: listener.unsubscribeType,
          listenerCallsAfterFirstGet: listener.callsAfterFirstGet,
          listenerCallsAfterTwoGets: listener.callsAfterTwoGets,
          listenerCallsAfterForceRefresh: listener.callsAfterForce,
          listenerCallsAfterLimitedUse: listener.callsAfterLimitedUse,
          listenerCallsAfterUnsubscribeAndForce: listener.callsAfterUnsubscribeAndForce,
          listenerCallsTotal: listener.callsTotal,
          listenerArgKeySets: listener.argKeySets,
          listenerTokenSequence: tokenLabels(listener.tokens),
          observerCallsTotal: observer.callsTotal,
          observerTokenSequence: tokenLabels(observer.tokens),
          lateListenerCallsSynchronous: late.callsSynchronous,
          lateListenerCallsWithin500ms: late.callsWithin500ms,
          lateListenerTokenSequence: tokenLabels(late.tokens),
        }, 'client');
    });

    await probe('app-check-client-auto-refresh-toggle', async () => {
      writeObservation(context, 'app-check-client-auto-refresh-toggle',
        'setTokenAutoRefreshEnabled(appCheck, false) and (appCheck, true) on an instance initialized with isTokenAutoRefreshEnabled false: whether each throws and what it returns, and that getToken still resolves the cached token afterwards. Background refresh timing is not observed.',
        {
          ...(main.setTokenAutoRefreshEnabled as Record<string, unknown>),
          getTokenAfterToggleReturnsCached: afterToggle.token === forcedAfterUnsubscribe.token,
        }, 'client');
    });

    await probe('app-check-client-ai-header', async () => {
      const invalidCaptured: CapturedRequest[] = [];
      const invalid = await openPage(await browser.newContext(), origin, input.unregisteredDebugToken, invalidCaptured, secrets);
      const invalidBehavior = await call<Record<string, unknown>>(invalid, 'invalidDebugToken', firebaseConfig);
      const invalidToken = invalidBehavior.getToken as Facts;
      if (invalidToken.token) secrets.values.push(invalidToken.token);
      writeObservation(context, 'app-check-client-invalid-debug-token',
        'getToken and getLimitedUseToken in debug mode with a random, unregistered debug token: whether each resolves or rejects, the error code and customData, the shape of any placeholder token, and the X-Firebase-AppCheck header firebase/ai then sends (normal model, and a second app whose getAI options set useLimitedUseAppCheckTokens), with the production response status and error body.',
        {
          customProviderCalls: invalidBehavior.providerCalls,
          getToken: invalidToken.threw ? invalidToken : shape(invalidToken),
          getLimitedUseToken: (invalidBehavior.getLimitedUseToken as Facts).threw
            ? invalidBehavior.getLimitedUseToken
            : shape(invalidBehavior.getLimitedUseToken as Facts),
          aiGeneration: invalidBehavior.generation,
          aiRequest: headerFacts(invalidCaptured[0], { getTokenResult: invalidToken.token }),
          aiLimitedUseGeneration: invalidBehavior.limitedGeneration,
          aiLimitedUseRequest: headerFacts(invalidCaptured[1], { getTokenResult: invalidToken.token }),
        }, 'client');

      writeObservation(context, 'app-check-client-ai-header',
        'The X-Firebase-AppCheck header the real firebase/ai SDK attaches to generateContent (GoogleAI backend, observed with a Playwright route and continued unchanged, enforcement off): with App Check initialized, on a second app whose getAI options set useLimitedUseAppCheckTokens (compared with that app\'s cached getToken token), and on an app that never initialized App Check. Each request records the production response status and, when not 200, the error body.',
        {
          appCheckInitialized: { ...headerFacts(generationRequest, { cachedGetToken: forcedAfterUnsubscribe.token }), generation: main.generation },
          limitedUseModel: {
            ...headerFacts(limitedRequest, { limitedUseAppCachedGetToken: limitedAppCached.token }),
            headerTokenIsNewLimitedUse: Boolean(limitedRequest?.appCheckHeader) && limitedRequest!.appCheckHeader !== limitedAppCached.token,
            generation: main.limitedGeneration,
          },
          noAppCheck: { ...headerFacts(plainRequest, {}), generation: main.plainGeneration },
        }, 'client');
    });
  } finally {
    await browser.close();
    server.stop(true);
  }
}
