/**
 * Prototype broker: speaks Firebase AI (Gemini v1beta) on the front,
 * Ollama's OpenAI-compatible endpoint on the back.
 *
 * Routes handled (matches @firebase/ai 2.12.0 RequestURL construction):
 *   POST /v1beta/projects/<project>/models/<model>:generateContent
 *   POST /v1beta/projects/<project>/models/<model>:streamGenerateContent?alt=sse
 *
 * Models prefixed `mock-` never hit Ollama; they return canned responses so
 * we can probe SDK tolerance for omitted/synthesized fields (test 6/7).
 */

import {
  geminiToOpenAIRequest,
  openAIToGeminiResponse,
  openAIChunkToGeminiResponse,
  modelNotFoundEnvelope,
  geminiErrorEnvelope,
  sseEvent,
  type GeminiRequest,
  type GeminiResponse,
  type OpenAIStreamChunk,
} from "./translator.ts";

const OLLAMA = process.env.OLLAMA_URL ?? "http://localhost:11434";
const PORT = Number(process.env.PORT ?? 8787);

const ROUTE_RE = /^\/v1beta\/projects\/[^/]+\/models\/(.+):(generateContent|streamGenerateContent)$/;

// ---------- mock responses for edge-synthesis probes ----------

function mockResponse(variant: string): { status: number; body: unknown } {
  const base: GeminiResponse = {
    candidates: [
      {
        index: 0,
        content: { role: "model", parts: [{ text: "mock text" }] },
        finishReason: "STOP",
        safetyRatings: [],
      },
    ],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
  };
  switch (variant) {
    case "full":
      return { status: 200, body: base };
    case "no-usage": {
      const { usageMetadata, ...rest } = base;
      return { status: 200, body: rest };
    }
    case "no-index": {
      const c = structuredClone(base);
      delete (c.candidates![0] as Record<string, unknown>).index;
      return { status: 200, body: c };
    }
    case "no-safety": {
      const c = structuredClone(base);
      delete (c.candidates![0] as Record<string, unknown>).safetyRatings;
      return { status: 200, body: c };
    }
    case "no-finish": {
      const c = structuredClone(base);
      delete (c.candidates![0] as Record<string, unknown>).finishReason;
      return { status: 200, body: c };
    }
    case "bad-finish": {
      const c = structuredClone(base);
      c.candidates![0].finishReason = "SAFETY";
      return { status: 200, body: c };
    }
    case "unknown-finish": {
      const c = structuredClone(base);
      c.candidates![0].finishReason = "BANANA";
      return { status: 200, body: c };
    }
    case "blocked":
      return {
        status: 200,
        body: { promptFeedback: { blockReason: "SAFETY", safetyRatings: [] } },
      };
    case "empty":
      return { status: 200, body: {} };
    default:
      return { status: 400, body: geminiErrorEnvelope(400, `unknown mock variant ${variant}`, "INVALID_ARGUMENT") };
  }
}

// ---------- server ----------

Bun.serve({
  port: PORT,
  idleTimeout: 180,
  async fetch(req) {
    const url = new URL(req.url);
    const m = url.pathname.match(ROUTE_RE);
    if (!m || req.method !== "POST") {
      return Response.json(geminiErrorEnvelope(404, `Unknown route ${url.pathname}`, "NOT_FOUND"), { status: 404 });
    }
    const [, model, task] = m;
    const streaming = task === "streamGenerateContent";
    const body = (await req.json()) as GeminiRequest;
    log(`-> ${task} model=${model}`);

    // Mock lane for edge probes
    if (model.startsWith("mock-")) {
      const { status, body: mock } = mockResponse(model.slice(5));
      if (streaming) {
        return new Response(sseEvent(mock as GeminiResponse), {
          status,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return Response.json(mock, { status });
    }

    const openaiReq = geminiToOpenAIRequest(model, body, streaming);
    if (process.env.DEBUG) log("openai req: " + JSON.stringify(openaiReq, null, 2));

    const upstream = await fetch(`${OLLAMA}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(openaiReq),
      signal: AbortSignal.timeout(120_000),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      log(`ollama error ${upstream.status}: ${errText}`);
      // Mirror production Gemini error envelopes. The main case: unknown model.
      if (upstream.status === 404 || /not found/i.test(errText)) {
        return Response.json(modelNotFoundEnvelope(model), { status: 404 });
      }
      return Response.json(
        geminiErrorEnvelope(upstream.status, safeOpenAIErrorMessage(errText), "INTERNAL"),
        { status: upstream.status }
      );
    }

    if (!streaming) {
      const openaiResp = await upstream.json();
      if (process.env.DEBUG) log("openai resp: " + JSON.stringify(openaiResp, null, 2));
      const gemini = openAIToGeminiResponse(openaiResp);
      log(`<- 200 finish=${gemini.candidates?.[0]?.finishReason}`);
      return Response.json(gemini);
    }

    // Streaming: re-frame OpenAI SSE chunks as Gemini SSE events.
    const out = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        try {
          for await (const chunk of readOpenAISSE(upstream.body!)) {
            const gemini = openAIChunkToGeminiResponse(chunk);
            if (gemini) controller.enqueue(enc.encode(sseEvent(gemini)));
          }
        } catch (e) {
          log(`stream error: ${e}`);
        }
        controller.close();
      },
    });
    return new Response(out, { headers: { "Content-Type": "text/event-stream" } });
  },
});

/** Parse OpenAI-style SSE ("data: {json}\n\n" ... "data: [DONE]"). */
async function* readOpenAISSE(body: ReadableStream<Uint8Array>): AsyncGenerator<OpenAIStreamChunk> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") return; // never forward the sentinel
        yield JSON.parse(payload) as OpenAIStreamChunk;
      }
    }
  }
}

function safeOpenAIErrorMessage(text: string): string {
  try {
    const j = JSON.parse(text);
    return j?.error?.message ?? text;
  } catch {
    return text;
  }
}

function log(msg: string) {
  console.log(`[proto ${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

console.log(`translator proto listening on http://localhost:${PORT} -> ${OLLAMA}`);
