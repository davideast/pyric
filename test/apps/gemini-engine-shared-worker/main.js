// The report's page (#1575): App Check with the debug provider first when
// asked, then Firebase AI Logic on gemini-2.5-flash.
import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { getAI, getGenerativeModel, GoogleAIBackend } from "firebase/ai";

const options = {
  apiKey: "AIzaSyDemoKeyForReproOnly000000000000",
  projectId: "demo-repro",
  appId: "1:123456789012:web:abcdef0123456789",
};

async function outcome(run) {
  try {
    return { ok: true, text: await run() };
  } catch (e) {
    return { ok: false, code: e?.code ?? null, status: e?.customErrorData?.status ?? null, message: String(e?.message ?? e) };
  }
}

window.runGemini = async (tag, withAppCheck) => {
  const app = initializeApp(options, tag);
  if (withAppCheck) {
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider("site-key"), isTokenAutoRefreshEnabled: true });
  }
  const model = getGenerativeModel(getAI(app, { backend: new GoogleAIBackend() }), { model: "gemini-2.5-flash" });
  return {
    generateContent: await outcome(async () => (await model.generateContent("Say hi")).response.text()),
    generateContentStream: await outcome(async () => (await (await model.generateContentStream("Say hi")).response).text()),
    countTokens: await outcome(async () => String((await model.countTokens("Say hi")).totalTokens)),
  };
};

// A model the scenario's stand-in refuses with an error that quotes the key:
// in the request URL (`gemini-echo-url`) or in plain text (`gemini-echo-key`).
window.runGeminiError = async (tag, modelName = "gemini-echo-url") => {
  const app = initializeApp(options, tag);
  self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider("site-key"), isTokenAutoRefreshEnabled: true });
  const model = getGenerativeModel(getAI(app, { backend: new GoogleAIBackend() }), { model: modelName });
  return outcome(async () => (await model.generateContent("Say hi")).response.text());
};

// A model the scenario's stand-in answers with a 200 stream that carries an
// error event mid-response, quoting the key (#1660). The page reports every
// chunk it iterates and how the aggregate settles, so the scenario can look
// for the key in what the app sees.
window.runGeminiStreamError = async (tag) => {
  const app = initializeApp(options, tag);
  self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider("site-key"), isTokenAutoRefreshEnabled: true });
  const model = getGenerativeModel(getAI(app, { backend: new GoogleAIBackend() }), { model: "gemini-stream-error" });
  const chunks = [];
  const settled = await outcome(async () => {
    const result = await model.generateContentStream("Say hi");
    for await (const chunk of result.stream) chunks.push(JSON.stringify(chunk));
    return JSON.stringify(await result.response);
  });
  return { chunks, settled };
};
