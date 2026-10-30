// The Firebase AI Logic calls an app makes, with and without App Check, shared
// by the page (main.js) and the registered Node process (ai-server.mjs).
// From November 2, 2026 AI Logic refuses requests without an App Check token.
import { initializeApp } from "firebase/app";
import { CustomProvider, ReCaptchaEnterpriseProvider, ReCaptchaV3Provider, initializeAppCheck } from "firebase/app-check";
import { getAI, getGenerativeModel } from "firebase/ai";

const options = {
  apiKey: "AIzaSyDemoKeyForReproOnly000000000000",
  projectId: "my-real-project",
  appId: "1:123456789012:web:abcdef0123456789",
};
const MODEL = "gemini-flash-lite-latest";
const SITE_KEY = "6Lc-site-key-from-the-console";

/** The page attests with reCAPTCHA. */
export const recaptchaProvider = () => new ReCaptchaV3Provider(SITE_KEY);

/** A server process has no `document` for reCAPTCHA, so it attests with a CustomProvider backed by its token server. */
export function tokenServerProvider(tokenUrl) {
  return () => new CustomProvider({ getToken: async () => (await fetch(tokenUrl)).json() });
}

function withAppCheck(app, makeProvider) {
  initializeAppCheck(app, { provider: makeProvider(), isTokenAutoRefreshEnabled: true });
  return app;
}

async function outcome(run) {
  try {
    await run();
    return "answered";
  } catch (error) {
    return { code: error?.code ?? null, status: error?.customErrorData?.status ?? null, message: String(error?.message ?? error) };
  }
}

function modelFor(ai) {
  return getGenerativeModel(ai, { model: MODEL });
}

/** Where the handle answers: `sandbox` in process, `transport` through a worker broker. */
function targetKind(ai) {
  for (const symbol of Object.getOwnPropertySymbols(ai)) {
    const value = ai[symbol];
    if (value && typeof value === "object" && "kind" in value) return value.kind;
  }
  return null;
}

/**
 * With no debug token set, the SDK calls a CustomProvider and sends the token
 * it returns; AI Logic refuses a token that is not a valid App Check token,
 * and the placeholder the SDK sends when the provider rejects (#1642). With
 * limited-use tokens there is no placeholder: the request is never sent, and
 * the SDK wraps the provider's error as `AIError` code `error`.
 */
async function customProviderOutcome(tag, name, getToken, aiOptions) {
  let calls = 0;
  const provider = new CustomProvider({
    getToken: async () => {
      calls += 1;
      return getToken();
    },
  });
  const app = initializeApp(options, `${tag}-custom-${name}`);
  initializeAppCheck(app, { provider, isTokenAutoRefreshEnabled: false });
  const result = await outcome(() => modelFor(getAI(app, aiOptions)).generateContent("ping"));
  return { providerCalled: calls > 0, result };
}

async function runCustomProviderChecks(tag, tokenUrl) {
  const hour = () => Date.now() + 3_600_000;
  return {
    valid: await customProviderOutcome(tag, "valid", async () => (await fetch(tokenUrl)).json()),
    invalidToken: await customProviderOutcome(tag, "invalid", async () => ({ token: "not-an-app-check-token", expireTimeMillis: hour() })),
    rejects: await customProviderOutcome(tag, "rejects", async () => {
      throw new Error("attestation failed");
    }),
    limitedUseRejects: await customProviderOutcome(tag, "limited-rejects", async () => {
      throw new Error("attestation failed");
    }, { useLimitedUseAppCheckTokens: true }),
  };
}

export async function runAiChecks(tag, tokenUrl, makeProvider = recaptchaProvider) {
  const bare = getAI(initializeApp(options, `${tag}-no-app-check`));
  const noAppCheck = {
    generateContent: await outcome(() => modelFor(bare).generateContent("ping")),
    generateContentStream: await outcome(async () => (await modelFor(bare).generateContentStream("ping")).response),
    countTokens: await outcome(() => modelFor(bare).countTokens("ping")),
  };

  const first = getAI(withAppCheck(initializeApp(options, `${tag}-app-check-first`), makeProvider));
  const appCheckFirst = {
    generateContent: await outcome(() => modelFor(first).generateContent("ping")),
    generateContentStream: await outcome(async () => (await modelFor(first).generateContentStream("ping")).response),
    countTokens: await outcome(() => modelFor(first).countTokens("ping")),
  };

  const lateApp = initializeApp(options, `${tag}-get-ai-first`);
  const late = getAI(lateApp);
  withAppCheck(lateApp, makeProvider);
  const getAiFirst = await outcome(() => modelFor(late).generateContent("ping"));

  globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  const debug = getAI(withAppCheck(initializeApp(options, `${tag}-debug-provider`), makeProvider));
  const debugProvider = await outcome(() => modelFor(debug).generateContent("ping"));
  delete globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN;

  const limited = getAI(withAppCheck(initializeApp(options, `${tag}-limited-use`), makeProvider), { useLimitedUseAppCheckTokens: true });
  const limitedUse = await outcome(() => modelFor(limited).generateContent("ping"));

  const customProvider = await runCustomProviderChecks(tag, tokenUrl);

  return { targetKind: targetKind(first), noAppCheck, appCheckFirst, getAiFirst, debugProvider, limitedUse, customProvider };
}

/** `returned`, the FirebaseError code, or the thrown error's name and message. */
export function thrown(run) {
  try {
    run();
    return "returned";
  } catch (error) {
    return error?.code ?? { name: error?.name ?? null, message: String(error?.message ?? error) };
  }
}

const RECAPTCHA_PROVIDERS = { ReCaptchaV3Provider, ReCaptchaEnterpriseProvider };

/**
 * In a process with no `document`, the SDK's reCAPTCHA providers throw from
 * `initializeAppCheck`, with or without the debug token, after App Check is
 * set up for the app: the same options then return its handle, and other
 * options are refused as a second initialization.
 */
function recaptchaOutcome(tag, name, debug) {
  const Provider = RECAPTCHA_PROVIDERS[name];
  const app = initializeApp(options, `${tag}-${name}-${debug ? "debug" : "no-debug"}`);
  if (debug) globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  try {
    return {
      first: thrown(() => initializeAppCheck(app, { provider: new Provider(SITE_KEY) })),
      sameOptions: thrown(() => initializeAppCheck(app, { provider: new Provider(SITE_KEY) })),
      otherSiteKey: thrown(() => initializeAppCheck(app, { provider: new Provider("another-site-key") })),
    };
  } finally {
    delete globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN;
  }
}

export function runRecaptchaChecks(tag) {
  const results = {};
  for (const name of Object.keys(RECAPTCHA_PROVIDERS)) {
    results[name] = { noDebug: recaptchaOutcome(tag, name, false), debug: recaptchaOutcome(tag, name, true) };
  }
  return results;
}
