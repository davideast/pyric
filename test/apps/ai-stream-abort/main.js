import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { getAI, getGenerativeModel, GoogleAIBackend } from "firebase/ai";

const options = {
  apiKey: "AIzaSyDemoKeyForReproOnly000000000000",
  projectId: "demo-abort",
  appId: "1:123456789012:web:abcdef0123456789",
};

function makeModel(tag, modelName) {
  self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  const app = initializeApp(options, tag);
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider("site-key"),
    isTokenAutoRefreshEnabled: true,
  });
  return getGenerativeModel(
    getAI(app, { backend: new GoogleAIBackend() }),
    { model: modelName },
  );
}

window.abortAfterChunks = async (tag, stopAfter) => {
  const model = makeModel(tag, "gemini-2.5-flash");
  const controller = new AbortController();
  const seen = [];
  let streamError = null;
  let responseError = null;
  let result;
  try {
    result = await model.generateContentStream("count", { signal: controller.signal });
    for await (const chunk of result.stream) {
      seen.push(chunk.text());
      if (seen.length === stopAfter) {
        controller.abort();
      }
    }
  } catch (err) {
    streamError = { name: err?.name ?? null, message: String(err?.message ?? err) };
  }
  if (result) {
    try {
      await result.response;
    } catch (err) {
      responseError = { name: err?.name ?? null, message: String(err?.message ?? err) };
    }
  }
  return { seen, streamError, responseError };
};

const pendingSlow = new Map();

window.startSlowHeaders = (tag) => {
  const model = makeModel(tag, "gemini-slow-headers");
  const controller = new AbortController();
  const promise = (async () => {
    let error = null;
    let chunks = 0;
    try {
      const result = await model.generateContentStream("slow", { signal: controller.signal });
      for await (const _chunk of result.stream) {
        chunks += 1;
      }
      await result.response;
    } catch (err) {
      error = { name: err?.name ?? null, message: String(err?.message ?? err) };
    }
    return { chunks, error };
  })();
  pendingSlow.set(tag, { controller, promise });
};

window.abortSlowHeaders = async (tag) => {
  const entry = pendingSlow.get(tag);
  pendingSlow.delete(tag);
  if (!entry) {
    throw new Error(`No pending slow-headers stream for tag: ${tag}`);
  }
  entry.controller.abort();
  return entry.promise;
};
