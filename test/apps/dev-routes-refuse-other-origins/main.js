import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc } from "firebase/firestore";
import { initializeAppCheck, ReCaptchaV3Provider } from "firebase/app-check";
import { getAI, getGenerativeModel, GoogleAIBackend } from "firebase/ai";

const app = initializeApp({ apiKey: "demo", appId: "demo", projectId: "demo-app" });
// Firebase AI Logic refuses requests without an App Check token; the sandbox accepts the debug provider's.
self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
initializeAppCheck(app, { provider: new ReCaptchaV3Provider("6Lc-site-key-from-the-console") });
const firestore =getFirestore(app);
const ai = getAI(app, { backend: new GoogleAIBackend() });

window.readDenied = () =>
  getDoc(doc(firestore, "denied-by-rules/doc-1")).then(() => "ok", (error) => error?.code ?? String(error));

window.askModel = async () => {
  try {
    const result = await getGenerativeModel(ai, { model: "gemini-flash-lite-latest" }).generateContent("Reply with one word: pong");
    return { ok: true, text: result.response.text().trim() };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};
