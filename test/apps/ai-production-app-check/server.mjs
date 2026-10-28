// A registered Node process in production AI mode: the same calls as the page.
// It records every module it loads, to report whether Pyric's App Check
// mirror is in its module graph (it must not be in production AI mode).
import { registerHooks } from "node:module";

const loaded = [];
registerHooks({
  load(url, context, nextLoad) {
    loaded.push(url);
    return nextLoad(url, context);
  },
});

const { initializeApp } = await import("firebase/app");
const { CustomProvider, getToken, initializeAppCheck } = await import("firebase/app-check");
const { getAI, getGenerativeModel } = await import("firebase/ai");

const seen = [];
globalThis.fetch = async (url, init) => {
  seen.push({ host: new URL(String(url)).hostname, appCheck: new Headers(init?.headers).get("x-firebase-appcheck") });
  return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "pong" }] }, finishReason: "STOP" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const app = initializeApp({
  apiKey: "AIzaSyDemoKeyForReproOnly000000000000",
  projectId: "my-real-project",
  appId: "1:123456789012:web:abcdef0123456789",
});
const appCheck = initializeAppCheck(app, {
  provider: new CustomProvider({ getToken: async () => ({ token: "attested-by-the-server", expireTimeMillis: Date.now() + 3_600_000 }) }),
  isTokenAutoRefreshEnabled: false,
});
const { token } = await getToken(appCheck);
await getGenerativeModel(getAI(app), { model: "gemini-flash-lite-latest" }).generateContent("Reply with one word: pong");
const mirrorLoaded = loaded.some((url) => /\/pyric\/(?:dist|src)\/app-check\//.test(url));
const bridgeLoaded = loaded.some((url) => /app-bridge-app-check/.test(url));
console.log(JSON.stringify({ token, seen, mirrorLoaded, bridgeLoaded }));
