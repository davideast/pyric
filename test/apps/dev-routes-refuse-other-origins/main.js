import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc } from "firebase/firestore";
import { getAI, getGenerativeModel, GoogleAIBackend } from "firebase/ai";

const app = initializeApp({ apiKey: "demo", appId: "demo", projectId: "demo-app" });
const firestore = getFirestore(app);
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
