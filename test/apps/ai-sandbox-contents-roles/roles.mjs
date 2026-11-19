// Shared by the page and the node script: App Check first, then AI, the order
// the App Check docs require. Sends the contents and request-edge shapes the scenario checks.
import { initializeApp } from "firebase/app";
import { ReCaptchaV3Provider, initializeAppCheck } from "firebase/app-check";
import { getAI, getGenerativeModel } from "firebase/ai";

const turn = (role, text) => ({ role, parts: [{ text }] });

function formatFailure(err) {
  let status = null;
  if (err && typeof err === "object" && err.customErrorData && typeof err.customErrorData.status === "number") {
    status = err.customErrorData.status;
  }
  let message = String(err);
  if (err && typeof err === "object" && typeof err.message === "string") {
    message = err.message;
  }
  return { ok: false, status, error: message };
}

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
  const ai = getAI(app);
  const model = getGenerativeModel(ai, { model: "gemini-flash-lite-latest" });
  const send = async (contents) => {
    try {
      const r = await model.generateContent({ contents });
      return { ok: true, text: r.response.text() };
    } catch (e) {
      return formatFailure(e);
    }
  };
  const sendChatStringSystem = async () => {
    try {
      const chat = model.startChat({ systemInstruction: "Answer in lowercase." });
      const r = await chat.sendMessage("Say hi.");
      return { ok: true, text: r.response.text() };
    } catch (e) {
      return formatFailure(e);
    }
  };
  const sendGeminiPro = async () => {
    try {
      const pro = getGenerativeModel(ai, { model: "gemini-pro" });
      const r = await pro.generateContent("Say hi.");
      return { ok: true, text: r.response.text() };
    } catch (e) {
      return formatFailure(e);
    }
  };
  return {
    assistant: await send([turn("user", "Say hi."), turn("assistant", "hi"), turn("user", "Say it again.")]),
    system: await send([turn("system", "Only reply with: pyric"), turn("user", "Say anything.")]),
    roleless: await send([{ parts: [{ text: "Say hi." }] }]),
    chatStringSystem: await sendChatStringSystem(),
    geminiPro: await sendGeminiPro(),
  };
}
