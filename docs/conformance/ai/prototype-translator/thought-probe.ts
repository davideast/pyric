import { initializeApp } from "firebase/app";
import { getAI, getGenerativeModel, GoogleAIBackend } from "firebase/ai";
const app = initializeApp({ apiKey: "fake", projectId: "demo-proto", appId: "1:1:web:f" }, "probe");
const ai = getAI(app, { backend: new GoogleAIBackend() });
const m = getGenerativeModel(ai, { model: "qwen3:4b" }, { baseUrl: "http://localhost:8787", timeout: 120000 });
const r = await m.generateContent("What is 2+2? Answer with just the number.");
console.log("text():", JSON.stringify(r.response.text()));
console.log("thoughtSummary():", JSON.stringify((r.response as any).thoughtSummary()?.slice(0, 120)));
process.exit(0);
