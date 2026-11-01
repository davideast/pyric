import { initializeApp } from "firebase/app";
import { CustomProvider, getToken, initializeAppCheck } from "firebase/app-check";
import { getAI, getGenerativeModel } from "firebase/ai";

const config = {
  apiKey: "AIzaSyDemoKeyForReproOnly000000000000",
  projectId: "my-real-project",
  appId: "1:123456789012:web:abcdef0123456789",
};
const provider = () =>
  new CustomProvider({
    getToken: async () => ({ token: "attested-by-the-app", expireTimeMillis: Date.now() + 3_600_000 }),
  });

async function ask(model) {
  try {
    const r = await getGenerativeModel(getAI(model.app), { model: "gemini-flash-lite-latest" })
      .generateContent("Reply with one word: pong");
    return { ok: true, text: r.response.text().trim() };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// App Check first, then AI: the order the App Check docs require.
window.runWithAppCheck = async () => {
  const app = initializeApp(config, "with-app-check");
  const appCheck = initializeAppCheck(app, { provider: provider(), isTokenAutoRefreshEnabled: false });
  const { token } = await getToken(appCheck);
  return { token, outcome: await ask({ app }) };
};

// The token the app attaches to its own API calls as X-Firebase-AppCheck. In
// production AI mode it comes from Firebase; the custom provider plays
// Firebase here and hands over the token the scenario signed.
window.tokenForBackend = async (issued) => {
  const app = initializeApp(config, "backend-calls");
  const provider = new CustomProvider({ getToken: async () => ({ token: issued, expireTimeMillis: Date.now() + 3_600_000 }) });
  const appCheck = initializeAppCheck(app, { provider, isTokenAutoRefreshEnabled: false });
  const { token } = await getToken(appCheck);
  return token;
};

// AI first, then App Check: the model was built before App Check existed.
window.runAppCheckAfterAi = async () => {
  const app = initializeApp(config, "app-check-after-ai");
  const model = getGenerativeModel(getAI(app), { model: "gemini-flash-lite-latest" });
  initializeAppCheck(app, { provider: provider(), isTokenAutoRefreshEnabled: false });
  try {
    await model.generateContent("Reply with one word: pong");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
};
