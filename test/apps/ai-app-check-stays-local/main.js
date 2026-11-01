// An app that follows pyric's AI Logic guide: App Check first, with the debug
// provider in development, then getAI. The imports are the Firebase SDK's.
import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaV3Provider } from "firebase/app-check";
import { getAI, getGenerativeModel } from "firebase/ai";

const options = {
  apiKey: "AIzaSyDemoKeyForReproOnly000000000000",
  projectId: "demo-ai-app-check",
  appId: "1:123456789012:web:abcdef0123456789",
};

const MODEL = "gemini-flash-lite-latest";

function failure(error) {
  return {
    ok: false,
    name: error?.name ?? null,
    code: error?.code ?? null,
    status: error?.customErrorData?.status ?? null,
    statusText: error?.customErrorData?.statusText ?? null,
    message: String(error?.message ?? error),
  };
}

async function settle(run) {
  try {
    return { ok: true, ...(await run()) };
  } catch (error) {
    return failure(error);
  }
}

async function generate(model) {
  const result = await model.generateContent("Summarise this report.");
  return { text: result.response.text() };
}

/** Each chunk's text as it arrives, then the aggregated response. */
async function stream(model) {
  const result = await model.generateContentStream("Stream a short reply.");
  const chunks = [];
  for await (const chunk of result.stream) chunks.push(chunk.text());
  return { chunks, text: (await result.response).text() };
}

async function run(app) {
  const model = getGenerativeModel(getAI(app), { model: MODEL });
  return { generateContent: await settle(() => generate(model)), generateContentStream: await settle(() => stream(model)) };
}

window.runWithAppCheck = () => {
  const app = initializeApp(options, "with-app-check");
  if (import.meta.env.DEV) self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider("your-recaptcha-v3-site-key"),
    isTokenAutoRefreshEnabled: true,
  });
  return run(app);
};

window.runWithoutAppCheck = () => run(initializeApp(options, "without-app-check"));

/**
 * A SharedWorker asks for a host outside the machine. The scenario's resolver
 * rules stop it, so the request never leaves; the scenario checks that its
 * request watch saw it, which proves the watch sees SharedWorker requests.
 */
window.runEgressControl = (url) =>
  new Promise((resolve) => {
    const worker = new SharedWorker("/control-worker.js", { name: "egress-control" });
    worker.port.onmessage = (event) => resolve(event.data);
    worker.port.postMessage(url);
  });
