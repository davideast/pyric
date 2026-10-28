/**
 * The page program for the App Check browser captures. It runs the installed
 * `firebase/app-check` and `firebase/ai` in headless Chromium and returns raw
 * values (tokens included) to the Node runner, which reduces them to shapes
 * before anything is written. The debug token arrives through
 * `self.FIREBASE_APPCHECK_DEBUG_TOKEN`, set by an init script before this
 * bundle loads.
 */
export const APP_CHECK_BROWSER_SOURCE = String.raw`
import { initializeApp } from 'firebase/app';
import {
  CustomProvider,
  getLimitedUseToken,
  getToken,
  initializeAppCheck,
  onTokenChanged,
  setTokenAutoRefreshEnabled,
} from 'firebase/app-check';
import { getAI, getGenerativeModel } from 'firebase/ai';

const MODEL = 'gemini-flash-lite-latest';
const PROMPT = 'Reply with exactly the word: pyric';
let providerCalls = 0;
const provider = () => new CustomProvider({
  getToken: async () => {
    providerCalls++;
    throw new Error('custom provider must not be called in debug mode');
  },
});

const errorFacts = (error) => ({
  threw: true,
  name: error?.name ?? null,
  code: error?.code ?? null,
  message: String(error?.message ?? error),
  customDataKeys: error?.customData ? Object.keys(error.customData).sort() : [],
  customData: error?.customData ?? null,
});
const settle = async (operation) => {
  try {
    const value = await operation();
    return { threw: false, value };
  } catch (error) {
    return errorFacts(error);
  }
};
const resultFacts = (result) => ({
  keySet: result && typeof result === 'object' ? Object.keys(result).sort() : [],
  token: result?.token ?? null,
  error: result?.error ? errorFacts(result.error) : null,
  internalError: result?.internalError ? errorFacts(result.internalError) : null,
});
const generate = (model) => settle(async () => {
  const response = await model.generateContent(PROMPT);
  return { finishReason: response.response.candidates?.[0]?.finishReason ?? null };
});

const initializeLimitedInvalid = (config) => {
  const app = initializeApp(config, 'invalid-limited-use');
  initializeAppCheck(app, { provider: provider(), isTokenAutoRefreshEnabled: false });
  return app;
};

globalThis.appCheckProbes = {
  async initializeTwice(config) {
    const app = initializeApp(config, 'twice');
    const shared = provider();
    const first = initializeAppCheck(app, { provider: shared, isTokenAutoRefreshEnabled: false });
    const same = await settle(() => initializeAppCheck(app, { provider: shared, isTokenAutoRefreshEnabled: false }));
    const otherProviderInstance = await settle(() => initializeAppCheck(app, { provider: provider(), isTokenAutoRefreshEnabled: false }));
    const otherRefresh = await settle(() => initializeAppCheck(app, { provider: shared, isTokenAutoRefreshEnabled: true }));
    return {
      sameOptions: same.threw ? same : { threw: false, returnsSameInstance: same.value === first },
      sameOptionsNewProviderInstance: otherProviderInstance.threw
        ? otherProviderInstance
        : { threw: false, returnsSameInstance: otherProviderInstance.value === first },
      differentAutoRefresh: otherRefresh.threw ? otherRefresh : { threw: false, returnsSameInstance: otherRefresh.value === first },
      instanceKeySet: Object.keys(first).sort(),
    };
  },

  async beforeInitialize(config) {
    const app = initializeApp(config, 'before');
    const publicGetToken = await settle(() => getToken({ app }));
    const aiApp = initializeApp(config, 'ai-first');
    const model = getGenerativeModel(getAI(aiApp), { model: MODEL });
    const lateInitialize = await settle(() => initializeAppCheck(aiApp, { provider: provider(), isTokenAutoRefreshEnabled: false }));
    const lateGetToken = lateInitialize.threw ? null : await settle(() => getToken(lateInitialize.value));
    const generation = await generate(model);
    return {
      publicGetTokenWithUninitializedApp: publicGetToken.threw ? publicGetToken : { threw: false, ...resultFacts(publicGetToken.value) },
      initializeAfterAi: lateInitialize.threw ? lateInitialize : { threw: false },
      getTokenAfterLateInitialize: lateGetToken && (lateGetToken.threw ? lateGetToken : { threw: false, ...resultFacts(lateGetToken.value) }),
      aiGenerationAfterLateInitialize: generation,
    };
  },

  async mainFlow(config) {
    const app = initializeApp(config, 'main');
    const appCheck = initializeAppCheck(app, { provider: provider(), isTokenAutoRefreshEnabled: false });
    const listenerCalls = [];
    const observerCalls = [];
    const unsubscribeListener = onTokenChanged(appCheck, (result) => listenerCalls.push(result));
    const unsubscribeObserver = onTokenChanged(appCheck, { next: (result) => observerCalls.push(result), error: () => {} });
    const settleListeners = () => new Promise((resolve) => setTimeout(resolve, 300));
    const first = await getToken(appCheck);
    await settleListeners();
    const listenerCallsAfterFirstGet = listenerCalls.length;
    const second = await getToken(appCheck);
    await settleListeners();
    const listenerCallsAfterTwoGets = listenerCalls.length;
    const forced = await getToken(appCheck, true);
    await settleListeners();
    const listenerCallsAfterForce = listenerCalls.length;
    const limitedA = await getLimitedUseToken(appCheck);
    const limitedB = await getLimitedUseToken(appCheck);
    const cachedAfterLimited = await getToken(appCheck);
    await settleListeners();
    const listenerCallsAfterLimited = listenerCalls.length;
    unsubscribeListener();
    unsubscribeObserver();
    const forcedAfterUnsubscribe = await getToken(appCheck, true);
    await settleListeners();
    const listenerCallsAfterUnsubscribe = listenerCalls.length;
    const lateListener = [];
    const unsubscribeLate = onTokenChanged(appCheck, (result) => lateListener.push(result));
    const lateCallsSynchronous = lateListener.length;
    await new Promise((resolve) => setTimeout(resolve, 500));
    unsubscribeLate();
    const autoRefreshOff = await settle(() => setTokenAutoRefreshEnabled(appCheck, false));
    const autoRefreshOn = await settle(() => setTokenAutoRefreshEnabled(appCheck, true));
    setTokenAutoRefreshEnabled(appCheck, false);
    const afterToggle = await getToken(appCheck);

    const model = getGenerativeModel(getAI(app), { model: MODEL });
    const generation = await generate(model);
    const limitedApp = initializeApp(config, 'limited-use');
    const limitedAppCheck = initializeAppCheck(limitedApp, { provider: provider(), isTokenAutoRefreshEnabled: false });
    const limitedAppCachedToken = await getToken(limitedAppCheck);
    const limitedModel = getGenerativeModel(getAI(limitedApp, { useLimitedUseAppCheckTokens: true }), { model: MODEL });
    const limitedGeneration = await generate(limitedModel);
    const plainApp = initializeApp(config, 'no-app-check');
    const plainGeneration = await generate(getGenerativeModel(getAI(plainApp), { model: MODEL }));
    return {
      providerCalls,
      first: resultFacts(first),
      second: resultFacts(second),
      forced: resultFacts(forced),
      limitedA: resultFacts(limitedA),
      limitedB: resultFacts(limitedB),
      cachedAfterLimited: resultFacts(cachedAfterLimited),
      limitedAppCachedToken: resultFacts(limitedAppCachedToken),
      forcedAfterUnsubscribe: resultFacts(forcedAfterUnsubscribe),
      afterToggle: resultFacts(afterToggle),
      listener: {
        unsubscribeType: typeof unsubscribeListener,
        callsAfterFirstGet: listenerCallsAfterFirstGet,
        callsAfterTwoGets: listenerCallsAfterTwoGets,
        callsAfterForce: listenerCallsAfterForce,
        callsAfterLimitedUse: listenerCallsAfterLimited,
        callsAfterUnsubscribeAndForce: listenerCallsAfterUnsubscribe,
        callsTotal: listenerCalls.length,
        argKeySets: listenerCalls.map((result) => Object.keys(result).sort()),
        tokens: listenerCalls.map((result) => result.token),
      },
      observer: { callsTotal: observerCalls.length, tokens: observerCalls.map((result) => result.token) },
      listenerRegisteredAfterTokenExists: { callsSynchronous: lateCallsSynchronous, callsWithin500ms: lateListener.length, tokens: lateListener.map((r) => r.token) },
      setTokenAutoRefreshEnabled: {
        offThrew: autoRefreshOff.threw,
        offReturn: autoRefreshOff.threw ? autoRefreshOff : String(autoRefreshOff.value),
        onThrew: autoRefreshOn.threw,
        onReturn: autoRefreshOn.threw ? autoRefreshOn : String(autoRefreshOn.value),
      },
      generation,
      limitedGeneration,
      plainGeneration,
    };
  },

  async invalidDebugToken(config) {
    const app = initializeApp(config, 'invalid');
    const appCheck = initializeAppCheck(app, { provider: provider(), isTokenAutoRefreshEnabled: false });
    const result = await settle(() => getToken(appCheck));
    const limited = await settle(() => getLimitedUseToken(appCheck));
    const generation = await generate(getGenerativeModel(getAI(app), { model: MODEL }));
    const limitedGeneration = await generate(
      getGenerativeModel(getAI(initializeLimitedInvalid(config), { useLimitedUseAppCheckTokens: true }), { model: MODEL }),
    );
    return {
      providerCalls,
      getToken: result.threw ? result : { threw: false, ...resultFacts(result.value) },
      getLimitedUseToken: limited.threw ? limited : { threw: false, ...resultFacts(limited.value) },
      generation,
      limitedGeneration,
    };
  },
};
`;
