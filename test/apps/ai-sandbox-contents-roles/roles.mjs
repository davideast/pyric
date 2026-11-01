// Shared by the page and the node script: App Check first, then AI, the order
// the App Check docs require. Sends the two contents shapes the scenario checks.
import { initializeApp } from "firebase/app";
import { ReCaptchaV3Provider, initializeAppCheck } from "firebase/app-check";
import { getAI, getGenerativeModel } from "firebase/ai";

const turn = (role, text) => ({ role, parts: [{ text }] });

export async function runRoles() {
  const app = initializeApp({
    apiKey: "AIzaSyDemoKeyForReproOnly000000000000",
    projectId: "my-real-project",
    appId: "1:123456789012:web:abcdef0123456789",
  });
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider("6Lc-site-key-from-the-console"),
    isTokenAutoRefreshEnabled: false,
  });
  const model = getGenerativeModel(getAI(app), { model: "gemini-flash-lite-latest" });
  const send = async (contents) => {
    try {
      const r = await model.generateContent({ contents });
      return { ok: true, text: r.response.text() };
    } catch (e) {
      return { ok: false, status: e?.customErrorData?.status ?? null, error: String(e?.message ?? e) };
    }
  };
  return {
    assistant: await send([turn("user", "Say hi."), turn("assistant", "hi"), turn("user", "Say it again.")]),
    system: await send([turn("system", "Only reply with: pyric"), turn("user", "Say anything.")]),
  };
}
