// The Firebase AI Logic calls an app makes, with and without App Check, shared
// by the page (main.js) and the registered Node process (ai-server.mjs).
// From November 2, 2026 AI Logic refuses requests without an App Check token.
import { initializeApp } from "firebase/app";
import { CustomProvider, ReCaptchaV3Provider, initializeAppCheck } from "firebase/app-check";
import { getAI, getGenerativeModel } from "firebase/ai";

const options = {
  apiKey: "AIzaSyDemoKeyForReproOnly000000000000",
  projectId: "my-real-project",
  appId: "1:123456789012:web:abcdef0123456789",
};
const MODEL = "gemini-flash-lite-latest";

function withAppCheck(app) {
  initializeAppCheck(app, { provider: new ReCaptchaV3Provider("6Lc-site-key-from-the-console"), isTokenAutoRefreshEnabled: true });
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

export async function runAiChecks(tag, tokenUrl) {
  const bare = getAI(initializeApp(options, `${tag}-no-app-check`));
  const noAppCheck = {
    generateContent: await outcome(() => modelFor(bare).generateContent("ping")),
    generateContentStream: await outcome(async () => (await modelFor(bare).generateContentStream("ping")).response),
    countTokens: await outcome(() => modelFor(bare).countTokens("ping")),
  };

  const first = getAI(withAppCheck(initializeApp(options, `${tag}-app-check-first`)));
  const appCheckFirst = {
    generateContent: await outcome(() => modelFor(first).generateContent("ping")),
    generateContentStream: await outcome(async () => (await modelFor(first).generateContentStream("ping")).response),
    countTokens: await outcome(() => modelFor(first).countTokens("ping")),
  };

  const lateApp = initializeApp(options, `${tag}-get-ai-first`);
  const late = getAI(lateApp);
  withAppCheck(lateApp);
  const getAiFirst = await outcome(() => modelFor(late).generateContent("ping"));

  globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  const debug = getAI(withAppCheck(initializeApp(options, `${tag}-debug-provider`)));
  const debugProvider = await outcome(() => modelFor(debug).generateContent("ping"));
  delete globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN;

  const limited = getAI(withAppCheck(initializeApp(options, `${tag}-limited-use`)), { useLimitedUseAppCheckTokens: true });
  const limitedUse = await outcome(() => modelFor(limited).generateContent("ping"));

  const customProvider = await runCustomProviderChecks(tag, tokenUrl);

  return { targetKind: targetKind(first), noAppCheck, appCheckFirst, getAiFirst, debugProvider, limitedUse, customProvider };
}
