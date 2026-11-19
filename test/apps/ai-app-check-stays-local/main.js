// An app that follows pyric's AI Logic guide: App Check first, with the debug
// provider in development, then getAI. The imports are the Firebase SDK's.
import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaV3Provider } from "firebase/app-check";
import { FunctionCallingMode, Schema, getAI, getGenerativeModel } from "firebase/ai";

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

window.runWave2Parity = async () => {
  const unauthApp = initializeApp(options, "wave2-without-app-check");
  const unauthModel = getGenerativeModel(getAI(unauthApp), { model: MODEL });
  const unauthCountTokens = await settle(() => unauthModel.countTokens("Count tokens without App Check."));

  const authApp = initializeApp(options, "wave2-with-app-check");
  if (import.meta.env.DEV) self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  initializeAppCheck(authApp, {
    provider: new ReCaptchaV3Provider("your-recaptcha-v3-site-key"),
    isTokenAutoRefreshEnabled: true,
  });
  const model = getGenerativeModel(getAI(authApp), {
    model: MODEL,
    tools: [
      {
        functionDeclarations: [
          {
            name: "get_weather",
            description: "Weather lookup.",
            parameters: Schema.object({ properties: { city: Schema.string() } }),
          },
        ],
      },
    ],
  });

  const authTokens = await model.countTokens("Count tokens with App Check.");
  const streamRes = await model.generateContentStream("Stream a short reply.");
  const streamChunks = [];
  for await (const chunk of streamRes.stream) streamChunks.push(chunk);
  const streamAgg = await streamRes.response;

  const chatSend = model.startChat();
  const sendRes = await chatSend.sendMessage("Send chat reply.");
  const sendHistory = await chatSend.getHistory();

  const chatStream = model.startChat();
  const chatStreamRes = await chatStream.sendMessageStream("Stream chat reply.");
  const chatChunks = [];
  for await (const chunk of chatStreamRes.stream) chatChunks.push(chunk.text());
  const chatAgg = await chatStreamRes.response;
  const chatStreamHistory = await chatStream.getHistory();

  const userTurn = { role: "user", parts: [{ text: "Call get_weather for Paris." }] };
  const fnTurn1 = await model.generateContent({
    contents: [userTurn],
    toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.ANY } },
  });
  const modelTurn1 = fnTurn1.response.candidates[0].content;
  const firstCall = fnTurn1.response.functionCalls()[0];
  const fnTurn2 = await model.generateContent({
    contents: [
      userTurn,
      modelTurn1,
      {
        role: "user",
        parts: [{ functionResponse: { name: "get_weather", response: { summary: "Sunny" } } }],
      },
    ],
  });

  return {
    unauthCountTokens,
    authCountTokensPositive: Number.isInteger(authTokens.totalTokens) && authTokens.totalTokens > 0,
    streamFinishOnlyLast:
      streamChunks.slice(0, -1).every((c) => c.candidates?.[0]?.finishReason === undefined) &&
      streamChunks[streamChunks.length - 1].candidates?.[0]?.finishReason === "STOP" &&
      streamChunks.every((c) => c.usageMetadata !== undefined),
    streamAggMatchesChunks: streamAgg.text() === streamChunks.map((c) => c.text()).join(""),
    sendRoleAndRoles: {
      role: sendRes.response.candidates[0].content.role,
      text: sendRes.response.text(),
      historyRoles: sendHistory.map((t) => t.role),
    },
    chatStreamSingleUserTurn: {
      text: chatAgg.text(),
      matchesChunks: chatAgg.text() === chatChunks.join(""),
      historyRoles: chatStreamHistory.map((t) => t.role),
      userTurnCount: chatStreamHistory.filter((t) => t.role === "user").length,
    },
    fnRoundTrip: {
      callKeys: Object.keys(firstCall).sort(),
      callName: firstCall.name,
      city: firstCall.args.city,
      turn1Finish: fnTurn1.response.candidates[0].finishReason,
      turn2Text: fnTurn2.response.text(),
      turn2CallsUndefined: fnTurn2.response.functionCalls() === undefined,
    },
  };
};

/**
 * A SharedWorker asks for a host outside the machine. The scenario's resolver
 * rules stop it, so the request never leaves; the scenario checks that its
 * request watch saw it, which proves the watch sees SharedWorker requests.
 * Opening the worker and sending it the URL are two calls, so the scenario
 * can wait in between until the watch records the worker's requests.
 */
let egressControl;

window.openEgressControl = () => {
  egressControl = new SharedWorker("/control-worker.js", { name: "egress-control" });
};

window.runEgressControl = (url) =>
  new Promise((resolve) => {
    egressControl.port.onmessage = (event) => resolve(event.data);
    egressControl.port.postMessage(url);
  });
