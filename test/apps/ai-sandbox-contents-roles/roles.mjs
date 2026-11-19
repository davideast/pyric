// Shared by the page and the node script: App Check first, then AI, the order
// the App Check docs require. Sends the contents and request-edge shapes the scenario checks.
import { FirebaseError, initializeApp } from "firebase/app";
import { ReCaptchaV3Provider, initializeAppCheck } from "firebase/app-check";
import { AIError, AnyOfSchema, Schema, getAI, getGenerativeModel } from "firebase/ai";

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
  const sendStructuredSchema = async () => {
    const objectSchema = Schema.object({
      properties: {
        city: Schema.string(),
        days: Schema.integer(),
      },
      optionalProperties: ["days"],
    });
    const enumSchema = Schema.enumString({ enum: ["red", "green", "blue"] });
    const anyOfSchema = Schema.anyOf({ anyOf: [Schema.string(), Schema.integer()] });
    let emptyAnyOfCode = null;
    let emptyAnyOfIsAIError = false;
    let emptyAnyOfIsFirebaseError = false;
    try {
      Schema.anyOf({ anyOf: [] });
    } catch (err) {
      emptyAnyOfIsAIError = err instanceof AIError;
      emptyAnyOfIsFirebaseError = err instanceof FirebaseError;
      if (err && typeof err === "object" && typeof err.code === "string") {
        emptyAnyOfCode = err.code;
      }
    }
    try {
      const r = await model.generateContent({
        contents: [turn("user", "Return a JSON city.")],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: objectSchema,
        },
      });
      return {
        ok: true,
        text: r.response.text(),
        objectJson: JSON.parse(JSON.stringify(objectSchema)),
        enumJson: JSON.parse(JSON.stringify(enumSchema)),
        anyOfJson: JSON.parse(JSON.stringify(anyOfSchema)),
        isAnyOfSchema: anyOfSchema instanceof AnyOfSchema,
        emptyAnyOfGuard: {
          isAIError: emptyAnyOfIsAIError,
          isFirebaseError: emptyAnyOfIsFirebaseError,
          code: emptyAnyOfCode,
        },
      };
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
    schemaBuilders: await sendStructuredSchema(),
  };
}
