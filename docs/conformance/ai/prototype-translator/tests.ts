/**
 * Drives the translator server with the REAL firebase/ai SDK (2.12.0) via the
 * RequestOptions.baseUrl override. Run the server first: `bun server.ts`.
 */

import { initializeApp } from "firebase/app";
import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  Schema,
  FunctionCallingMode,
  type Tool,
} from "firebase/ai";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const MODEL = process.env.MODEL ?? "qwen3:4b";
const TOOL_MODEL = process.env.TOOL_MODEL ?? MODEL;

const app = initializeApp({
  apiKey: "fake-api-key",
  projectId: "demo-proto",
  appId: "1:1234:web:fake",
});
const ai = getAI(app, { backend: new GoogleAIBackend() });

const opts = { baseUrl: BASE, timeout: 120_000 };

function model(name: string, extra: Record<string, unknown> = {}) {
  return getGenerativeModel(ai, { model: name, ...extra }, opts);
}

type Result = { test: string; verdict: string; evidence: string };
const results: Result[] = [];
function record(test: string, verdict: string, evidence: string) {
  results.push({ test, verdict, evidence });
  console.log(`\n=== ${test} -> ${verdict}\n${evidence}`);
}

const trunc = (s: string, n = 220) => (s.length > n ? s.slice(0, n) + "…" : s).replace(/\n/g, "\\n");

// ---------- 1. plain text ----------
async function testPlainText() {
  const m = model(MODEL);
  const r = await m.generateContent("Reply with exactly: hello broker");
  const resp = r.response;
  const text = resp.text();
  const cand = (resp as any).candidates?.[0];
  const usage = resp.usageMetadata;
  const ok = text.length > 0 && cand?.finishReason === "STOP" && usage?.totalTokenCount > 0;
  record(
    "1 plain generateContent",
    ok ? "faithful" : "degraded",
    `text=${JSON.stringify(trunc(text))} finishReason=${cand?.finishReason} usage=${JSON.stringify(usage)}`
  );
}

// ---------- 2. streaming ----------
async function testStreaming() {
  const m = model(MODEL);
  const r = await m.generateContentStream("Count from 1 to 5, digits separated by spaces.");
  let chunks = 0;
  let streamed = "";
  for await (const chunk of r.stream) {
    chunks++;
    streamed += chunk.text();
  }
  const agg = await r.response;
  const aggText = agg.text();
  const ok = chunks > 1 && aggText === streamed && aggText.length > 0;
  record(
    "2 generateContentStream",
    ok ? "faithful" : "degraded",
    `chunks=${chunks} streamed==aggregated=${aggText === streamed} agg=${JSON.stringify(trunc(aggText))} usage=${JSON.stringify(agg.usageMetadata)} finish=${(agg as any).candidates?.[0]?.finishReason}`
  );
}

// ---------- 3. multi-turn chat + systemInstruction ----------
async function testChat() {
  const m = model(MODEL, {
    systemInstruction: "You are a pirate. Always start your reply with 'Arr'. Keep replies under 10 words.",
  });
  const chat = m.startChat({
    history: [
      { role: "user", parts: [{ text: "My name is Dax." }] },
      { role: "model", parts: [{ text: "Arr, nice to meet ye, Dax." }] },
    ],
  });
  const r = await chat.sendMessage("What is my name?");
  const text = r.response.text();
  const history = await chat.getHistory();
  const ok = /dax/i.test(text) && history.length === 4 && history[3].role === "model";
  record(
    "3 multi-turn chat + system",
    ok ? "faithful" : /arr/i.test(text) ? "faithful (system honored; name recall is model quality)" : "degraded",
    `reply=${JSON.stringify(trunc(text))} historyLen=${history.length} roles=${history.map(h => h.role).join(",")}`
  );
}

// ---------- 4. function calling round trip ----------
async function testFunctionCalling() {
  const tools: Tool[] = [
    {
      functionDeclarations: [
        {
          name: "get_weather",
          description: "Get current weather for a city",
          parameters: Schema.object({
            properties: { city: Schema.string({ description: "City name" }) },
          }),
        },
      ],
    },
  ];
  const m = model(TOOL_MODEL, {
    tools,
    toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.ANY } },
  });
  const chat = m.startChat();
  const r1 = await chat.sendMessage("What's the weather in Paris?");
  const calls = r1.response.functionCalls();
  if (!calls?.length) {
    record(
      "4 function calling",
      "degraded (model emitted no tool_calls; translation path untested this run)",
      `parts=${JSON.stringify((r1.response as any).candidates?.[0]?.content?.parts).slice(0, 300)}`
    );
    return;
  }
  const call = calls[0];
  const argsIsObject = typeof call.args === "object" && !Array.isArray(call.args);
  const r2 = await chat.sendMessage([
    {
      functionResponse: {
        name: call.name,
        response: { city: (call.args as any).city, tempC: 21, condition: "sunny" },
      },
    },
  ]);
  const final = r2.response.text();
  const ok = call.name === "get_weather" && argsIsObject && /21|sunny/i.test(final);
  record(
    "4 function calling round trip",
    ok ? "faithful" : "degraded",
    `call=${call.name} args=${JSON.stringify(call.args)} argsIsObject=${argsIsObject} final=${JSON.stringify(trunc(final))}`
  );
}

// ---------- 5. structured output ----------
async function testStructuredOutput() {
  const schema = Schema.object({
    properties: {
      name: Schema.string(),
      ageYears: Schema.integer(),
    },
  });
  const m = model(MODEL, {
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema,
    },
  });
  const r = await m.generateContent("Describe a fictional wizard.");
  const text = r.response.text();
  let parsed: any = null;
  let parseErr = "";
  try {
    parsed = JSON.parse(text);
  } catch (e: any) {
    parseErr = e.message;
  }
  const ok = parsed && typeof parsed.name === "string" && Number.isInteger(parsed.ageYears);
  record(
    "5 structured output (responseSchema)",
    ok ? "faithful" : "degraded",
    `raw=${JSON.stringify(trunc(text))} parsed=${JSON.stringify(parsed)} err=${parseErr}`
  );
}

// ---------- 6. edge synthesis probes (mock lane, no model) ----------
async function probeMock(variant: string, exercise: (resp: any) => string): Promise<string> {
  try {
    const m = model(`mock-${variant}`);
    const r = await m.generateContent("x");
    return exercise(r.response);
  } catch (e: any) {
    return `THROWS: ${trunc(String(e.message ?? e), 160)}`;
  }
}

async function testEdgeSynthesis() {
  const lines: string[] = [];
  lines.push(`omit usageMetadata: ${await probeMock("no-usage", r => `text()=${JSON.stringify(r.text())} usage=${JSON.stringify(r.usageMetadata)}`)}`);
  lines.push(`omit candidate.index: ${await probeMock("no-index", r => `text()=${JSON.stringify(r.text())}`)}`);
  lines.push(`omit safetyRatings: ${await probeMock("no-safety", r => `text()=${JSON.stringify(r.text())}`)}`);
  lines.push(`omit finishReason: ${await probeMock("no-finish", r => `text()=${JSON.stringify(r.text())}`)}`);
  lines.push(`finishReason SAFETY: ${await probeMock("bad-finish", r => `text()=${JSON.stringify(r.text())}`)}`);
  lines.push(`finishReason BANANA (unknown): ${await probeMock("unknown-finish", r => `text()=${JSON.stringify(r.text())}`)}`);
  lines.push(`no candidates + promptFeedback.blockReason: ${await probeMock("blocked", r => `text()=${JSON.stringify(r.text())}`)}`);
  lines.push(`entirely empty {}: ${await probeMock("empty", r => `text()=${JSON.stringify(r.text())}`)}`);
  record("6 edge synthesis / omission tolerance", "see evidence", lines.join("\n"));
}

// ---------- 7. error mapping ----------
async function testErrorMapping() {
  try {
    const m = model("definitely-not-a-model");
    await m.generateContent("hi");
    record("7 unknown-model error mapping", "degraded", "no error thrown");
  } catch (e: any) {
    const msg = String(e.message ?? e);
    const ok =
      /404/.test(msg) && /models\/definitely-not-a-model is not found for API version/.test(msg);
    record(
      "7 unknown-model error mapping",
      ok ? "faithful" : "degraded",
      `AIError.code=${e.code} customData.status=${e.customData?.status} message=${trunc(msg, 300)}`
    );
  }
}

// ---------- run ----------
const only = process.env.ONLY;
const suite: Array<[string, () => Promise<void>]> = [
  ["1", testPlainText],
  ["2", testStreaming],
  ["3", testChat],
  ["4", testFunctionCalling],
  ["5", testStructuredOutput],
  ["6", testEdgeSynthesis],
  ["7", testErrorMapping],
];
for (const [id, fn] of suite) {
  if (only && !only.split(",").includes(id)) continue;
  try {
    await fn();
  } catch (e: any) {
    record(`${id} (harness)`, "ERROR", trunc(String(e.stack ?? e), 500));
  }
}

console.log("\n\n================ RESULTS ================");
for (const r of results) {
  console.log(`\n[${r.verdict}] ${r.test}\n  ${r.evidence.split("\n").join("\n  ")}`);
}
process.exit(0);
