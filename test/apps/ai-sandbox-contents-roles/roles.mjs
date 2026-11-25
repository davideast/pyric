// Shared by the page and the node script: App Check first, then AI, the order
// the App Check docs require. Sends the contents and request-edge shapes the scenario checks.
import { FirebaseError, initializeApp } from "firebase/app";
import { ReCaptchaV3Provider, initializeAppCheck } from "firebase/app-check";
import * as aiNamespace from "firebase/ai";
import {
  AIError,
  AIErrorCode,
  AnyOfSchema,
  BackendType,
  GoogleAIBackend,
  POSSIBLE_ROLES,
  Schema,
  getAI,
  getGenerativeModel,
} from "firebase/ai";
import { checkGenerateAndHelpers } from "./generate-helpers-check.mjs";
import { checkDeletedAppAiLifecycle } from "./deleted-app-ai-check.mjs";

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
  const baseOptions = {
    apiKey: "AIzaSyDemoKeyForReproOnly000000000000",
    projectId: "my-real-project",
    appId: "1:123456789012:web:abcdef0123456789",
  };
  const app = initializeApp(baseOptions);
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
  const checkChatErrorsAbort = async () => {
    const controller = new AbortController();
    controller.abort();
    let abortContentName = null;
    let abortContentIsAIError = false;
    try {
      await model.generateContent(
        { contents: [turn("user", "never delivered")] },
        { signal: controller.signal },
      );
    } catch (err) {
      abortContentIsAIError = err instanceof AIError;
      if (err && typeof err === "object" && typeof err.name === "string") {
        abortContentName = err.name;
      }
    }

    let abortStringName = null;
    try {
      await model.generateContent("never delivered", { signal: AbortSignal.abort() });
    } catch (err) {
      if (err && typeof err === "object" && typeof err.name === "string") {
        abortStringName = err.name;
      }
    }

    const defaultChat = model.startChat();
    const defaultHistory = await defaultChat.getHistory();
    const seededChat = model.startChat({
      history: [
        { role: "user", parts: [{ text: "hi" }] },
        { role: "model", parts: [{ functionCall: { name: "greet", args: { target: "world" } } }] },
        { role: "function", parts: [{ functionResponse: { name: "greet", response: { ok: true } } }] },
      ],
    });
    const seededHistory = await seededChat.getHistory();

    let emptyPartsCode = null;
    let emptyPartsIsFirebaseError = false;
    try {
      model.startChat({ history: [{ role: "user", parts: [] }] });
    } catch (err) {
      emptyPartsIsFirebaseError = err instanceof FirebaseError;
      if (err && typeof err === "object" && typeof err.code === "string") {
        emptyPartsCode = err.code;
      }
    }

    let modelFirstCode = null;
    try {
      model.startChat({ history: [{ role: "model", parts: [{ text: "first" }] }] });
    } catch (err) {
      if (err && typeof err === "object" && typeof err.code === "string") {
        modelFirstCode = err.code;
      }
    }

    const constructed = new AIError(AIErrorCode.FETCH_ERROR, "sample failure", {
      status: 400,
      statusText: "Bad Request",
      errorDetails: [{ reason: "API_KEY_INVALID" }],
    });
    let constructedStatus = null;
    let constructedReason = null;
    if (constructed.customErrorData) {
      if (typeof constructed.customErrorData.status === "number") {
        constructedStatus = constructed.customErrorData.status;
      }
      const details = constructed.customErrorData.errorDetails;
      if (Array.isArray(details) && details.length > 0 && typeof details[0].reason === "string") {
        constructedReason = details[0].reason;
      }
    }

    return {
      abortContentName,
      abortContentIsAIError,
      abortStringName,
      isChatSession:
        typeof seededChat.sendMessage === "function" &&
        typeof seededChat.sendMessageStream === "function" &&
        typeof seededChat.getHistory === "function" &&
        !("ChatSession" in aiNamespace),
      defaultHistoryLength: defaultHistory.length,
      seededRoles: seededHistory.map((entry) => entry.role),
      emptyPartsCode,
      emptyPartsIsFirebaseError,
      modelFirstCode,
      possibleRoles: [...POSSIBLE_ROLES],
      errorCodeCount: Object.values(AIErrorCode).length,
      constructedError: {
        isAIError: constructed instanceof AIError,
        isFirebaseError: constructed instanceof FirebaseError,
        code: constructed.code,
        status: constructedStatus,
        reason: constructedReason,
      },
    };
  };
  const checkInitBackends = async () => {
    const repeatDefaultAi = getAI(app);
    const explicitGoogleAi = getAI(app, { backend: new GoogleAIBackend() });
    const regionalDefault = { backendType: BackendType.AGENT_PLATFORM, location: "us-central1" };
    const regionalAiDefault = getAI(app, { backend: regionalDefault });
    const repeatRegionalAiDefault = getAI(app, {
      backend: { backendType: BackendType.AGENT_PLATFORM, location: "us-central1" },
    });
    const regionalEurope = { backendType: BackendType.AGENT_PLATFORM, location: "europe-west1" };
    const regionalAiEurope = getAI(app, { backend: regionalEurope });

    const googlePrefixedModel = getGenerativeModel(ai, {
      model: "models/gemini-flash-lite-latest",
    });
    const regionalShortModel = getGenerativeModel(regionalAiDefault, {
      model: "gemini-flash-lite-latest",
    });

    let emptyModelCode = null;
    let emptyModelName = null;
    let emptyModelIsAIError = false;
    let emptyModelIsFirebaseError = false;
    try {
      getGenerativeModel(ai, { model: "" });
    } catch (err) {
      emptyModelIsAIError = err instanceof AIError;
      emptyModelIsFirebaseError = err instanceof FirebaseError;
      if (err && typeof err === "object") {
        if (typeof err.code === "string") {
          emptyModelCode = err.code;
        }
        if (typeof err.name === "string") {
          emptyModelName = err.name;
        }
      }
    }

    try {
      const regionalReply = await regionalShortModel.generateContent("Say hi on regional backend.");
      return {
        ok: true,
        text: regionalReply.response.text(),
        carriesApp: ai.app === app,
        isGoogleAIBackend: ai.backend instanceof GoogleAIBackend,
        backendType: ai.backend.backendType,
        matchesEnumGoogleAi: ai.backend.backendType === BackendType.GOOGLE_AI,
        hasHandleLocation: "location" in ai,
        hasVertexAIBackend: "VertexAIBackend" in aiNamespace,
        hasVertexAiEnum: "VERTEX_AI" in BackendType,
        sameAppDefaultSameHandle: ai === repeatDefaultAi,
        sameAppExplicitGoogleSameHandle: ai === explicitGoogleAi,
        sameAppRegionalSameHandle: regionalAiDefault === repeatRegionalAiDefault,
        googleAndRegionalDistinctOnSameApp: ai !== regionalAiDefault,
        regionalLocationsDistinctOnSameApp: regionalAiDefault !== regionalAiEurope,
        googleShortNormalized: model.model,
        googlePrefixedNormalized: googlePrefixedModel.model,
        regionalShortNormalized: regionalShortModel.model,
        emptyModelGuard: {
          isAIError: emptyModelIsAIError,
          isFirebaseError: emptyModelIsFirebaseError,
          code: emptyModelCode,
          name: emptyModelName,
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
    chatErrorsAbort: await checkChatErrorsAbort(),
    initBackends: await checkInitBackends(),
    generateHelpers: await checkGenerateAndHelpers(model),
    deletedAppLifecycle: await checkDeletedAppAiLifecycle(baseOptions),
  };
}
