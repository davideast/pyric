import { initializeApp } from "firebase/app";
import { getAI, getGenerativeModel, GoogleAIBackend, VertexAIBackend } from "firebase/ai";

const app = initializeApp({
  apiKey: "AIzaSyDemoKeyForReproOnly000000000000",
  projectId: "my-real-project",
  appId: "1:123456789012:web:abcdef0123456789",
});
const backends = {
  vertex: getAI(app, { backend: new VertexAIBackend("global") }),
  google: getAI(app, { backend: new GoogleAIBackend() }),
};

window.runRepro = async (backend, model) => {
  try {
    const r = await getGenerativeModel(backends[backend], { model }).generateContent("Reply with one word: pong");
    return { ok: true, modelVersion: r.response.modelVersion ?? null, text: r.response.text().trim() };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
};
