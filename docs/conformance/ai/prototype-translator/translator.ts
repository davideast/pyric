/**
 * OpenAI <-> Gemini (Firebase AI v1beta) wire-format translator.
 *
 * Request direction:  Gemini GenerateContentRequest -> OpenAI /v1/chat/completions body
 * Response direction: OpenAI chat completion (+ stream chunks) -> Gemini GenerateContentResponse
 *
 * Written as a throwaway prototype for wayfinder #96, but shaped so the pure
 * functions can be lifted into the broker later. No I/O in this file.
 */

// ---------- Gemini-side types (minimal, matching @firebase/ai wire shapes) ----------

export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  inlineData?: { mimeType: string; data: string };
  thought?: boolean;
}

export interface GeminiContent {
  role: "user" | "model" | "function" | "system";
  parts: GeminiPart[];
}

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: GeminiContent | { parts: GeminiPart[] };
  tools?: Array<{
    functionDeclarations?: Array<{
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    }>;
  }>;
  toolConfig?: {
    functionCallingConfig?: { mode?: "AUTO" | "ANY" | "NONE"; allowedFunctionNames?: string[] };
  };
  generationConfig?: {
    temperature?: number;
    topP?: number;
    topK?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    responseMimeType?: string;
    responseSchema?: Record<string, unknown>;
    frequencyPenalty?: number;
    presencePenalty?: number;
  };
}

export interface GeminiCandidate {
  index: number;
  content: { role: "model"; parts: GeminiPart[] };
  finishReason?: string;
  safetyRatings?: unknown[];
  citationMetadata?: unknown;
}

export interface GeminiResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: string; safetyRatings?: unknown[] };
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  modelVersion?: string;
}

// ---------- OpenAI-side types (minimal) ----------

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  tools?: Array<{ type: "function"; function: Record<string, unknown> }>;
  tool_choice?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  response_format?:
    | { type: "json_object" }
    | { type: "json_schema"; json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean } };
  frequency_penalty?: number;
  presence_penalty?: number;
}

export interface OpenAIResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string | null; tool_calls?: OpenAIToolCall[]; reasoning?: string };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface OpenAIStreamChunk {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      reasoning?: string;
      tool_calls?: Array<Partial<OpenAIToolCall> & { index: number }>;
    };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// ---------- Request translation: Gemini -> OpenAI ----------

/**
 * Gemini functionResponse parts carry only a function *name*; OpenAI tool
 * messages require the tool_call_id of the originating call. We synthesize
 * deterministic ids when translating the model's functionCall parts and
 * look them up by name (FIFO per name) for the responses.
 */
function synthToolCallId(name: string, ordinal: number): string {
  return `call_${name}_${ordinal}`;
}

export function geminiToOpenAIRequest(
  model: string,
  req: GeminiRequest,
  stream: boolean
): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  // systemInstruction -> leading system message
  if (req.systemInstruction) {
    const text = (req.systemInstruction.parts ?? [])
      .map(p => p.text ?? "")
      .join("");
    if (text) messages.push({ role: "system", content: text });
  }

  // Walk contents. Track pending tool-call ids per function name so a later
  // functionResponse turn can reference the right id.
  const pendingIdsByName = new Map<string, string[]>();
  let callOrdinal = 0;

  for (const content of req.contents ?? []) {
    if (content.role === "function") {
      // functionResponse turn -> one OpenAI `tool` message per part
      for (const part of content.parts) {
        if (!part.functionResponse) continue;
        const queue = pendingIdsByName.get(part.functionResponse.name) ?? [];
        const id = queue.shift() ?? synthToolCallId(part.functionResponse.name, callOrdinal++);
        messages.push({
          role: "tool",
          tool_call_id: id,
          content: JSON.stringify(part.functionResponse.response),
        });
      }
      continue;
    }

    const role = content.role === "model" ? "assistant" : "user";
    const textParts: string[] = [];
    const toolCalls: OpenAIToolCall[] = [];

    for (const part of content.parts) {
      // Thought parts (from our reasoning mapping) must not be replayed to
      // OpenAI as assistant text; real Gemini also does not accept thought
      // text back (only thoughtSignatures).
      if (part.thought) continue;
      if (typeof part.text === "string") {
        textParts.push(part.text);
      } else if (part.functionCall) {
        const id = synthToolCallId(part.functionCall.name, callOrdinal++);
        const queue = pendingIdsByName.get(part.functionCall.name) ?? [];
        queue.push(id);
        pendingIdsByName.set(part.functionCall.name, queue);
        toolCalls.push({
          id,
          type: "function",
          // LOSSY EDGE: Gemini args is an object; OpenAI wants a JSON string.
          function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) },
        });
      } else if (part.inlineData) {
        // Not exercised in this prototype; Ollama's OpenAI endpoint supports
        // image_url content parts. Left as a marked gap.
        textParts.push(`[unsupported inlineData part: ${part.inlineData.mimeType}]`);
      }
      // `thought` parts are Gemini-only; dropped on the floor.
    }

    const msg: OpenAIMessage = {
      role,
      content: textParts.length ? textParts.join("") : null,
    };
    if (toolCalls.length) msg.tool_calls = toolCalls;
    messages.push(msg);
  }

  const out: OpenAIRequest = { model, messages, stream };
  if (stream) out.stream_options = { include_usage: true };

  // tools
  const decls = (req.tools ?? []).flatMap(t => t.functionDeclarations ?? []);
  if (decls.length) {
    out.tools = decls.map(d => ({
      type: "function",
      function: {
        name: d.name,
        description: d.description,
        parameters: normalizeSchema(d.parameters) ?? { type: "object", properties: {} },
      },
    }));
  }

  // toolConfig.mode -> tool_choice
  const mode = req.toolConfig?.functionCallingConfig?.mode;
  if (mode === "ANY") out.tool_choice = "required";
  else if (mode === "NONE") out.tool_choice = "none";
  else if (mode === "AUTO") out.tool_choice = "auto";

  // generationConfig
  const g = req.generationConfig;
  if (g) {
    if (g.temperature !== undefined) out.temperature = g.temperature;
    if (g.topP !== undefined) out.top_p = g.topP;
    if (g.maxOutputTokens !== undefined) out.max_tokens = g.maxOutputTokens;
    if (g.stopSequences?.length) out.stop = g.stopSequences;
    if (g.frequencyPenalty !== undefined) out.frequency_penalty = g.frequencyPenalty;
    if (g.presencePenalty !== undefined) out.presence_penalty = g.presencePenalty;
    // LOSSY EDGE: topK has no OpenAI equivalent; dropped.
    if (g.responseMimeType === "application/json") {
      out.response_format = g.responseSchema
        ? {
            type: "json_schema",
            json_schema: { name: "response", schema: normalizeSchema(g.responseSchema)!, strict: true },
          }
        : { type: "json_object" };
    }
  }

  return out;
}

/**
 * Gemini schemas allow uppercase type names ("STRING") and a `nullable` flag;
 * OpenAI/JSON-Schema wants lowercase types. @firebase/ai's Schema builder
 * already emits lowercase, but normalize defensively and strip fields JSON
 * Schema validators reject.
 */
function normalizeSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const s = { ...(schema as Record<string, unknown>) };
  if (typeof s.type === "string") s.type = (s.type as string).toLowerCase();
  delete s.nullable;
  if (s.properties && typeof s.properties === "object") {
    s.properties = Object.fromEntries(
      Object.entries(s.properties as Record<string, unknown>).map(([k, v]) => [k, normalizeSchema(v)])
    );
  }
  if (s.items) s.items = normalizeSchema(s.items);
  return s;
}

// ---------- Response translation: OpenAI -> Gemini ----------

const FINISH_REASON_MAP: Record<string, string> = {
  stop: "STOP",
  length: "MAX_TOKENS",
  // A tool call is a normal, expected stop in Gemini's model; mapping to
  // anything in badFinishReasons would make the SDK throw on response.text().
  tool_calls: "STOP",
  // Faithful mapping: SAFETY makes the SDK's response.text() throw, which is
  // exactly what the real backend's behavior would be.
  content_filter: "SAFETY",
};

export function mapFinishReason(reason: string | null | undefined): string {
  if (!reason) return "STOP";
  return FINISH_REASON_MAP[reason] ?? "OTHER";
}

function messagePartsFromOpenAI(msg: {
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  reasoning?: string;
}): GeminiPart[] {
  const parts: GeminiPart[] = [];
  // Ollama's OpenAI compat surfaces thinking-model output in a nonstandard
  // `reasoning` field. Gemini represents this as a thought part; the SDK's
  // text() filters `!part.thought` and thoughtSummary() returns them, so this
  // mapping is faithful.
  if (msg.reasoning) parts.push({ text: msg.reasoning, thought: true });
  if (msg.content) parts.push({ text: msg.content });
  for (const tc of msg.tool_calls ?? []) {
    let args: Record<string, unknown> = {};
    try {
      // LOSSY EDGE in reverse: OpenAI arguments is a JSON *string*; Gemini
      // wants an object. A model that emits malformed JSON here would map to
      // finishReason MALFORMED_FUNCTION_CALL on real Gemini.
      args = JSON.parse(tc.function.arguments || "{}");
    } catch {
      args = { __malformed: tc.function.arguments };
    }
    parts.push({ functionCall: { name: tc.function.name, args } });
  }
  if (!parts.length) parts.push({ text: "" });
  return parts;
}

export function openAIToGeminiResponse(resp: OpenAIResponse): GeminiResponse {
  const choice = resp.choices[0];
  const malformedToolArgs = (choice.message.tool_calls ?? []).some(tc => {
    try {
      JSON.parse(tc.function.arguments || "{}");
      return false;
    } catch {
      return true;
    }
  });
  const candidate: GeminiCandidate = {
    index: 0,
    content: { role: "model", parts: messagePartsFromOpenAI(choice.message) },
    finishReason: malformedToolArgs
      ? "MALFORMED_FUNCTION_CALL"
      : mapFinishReason(choice.finish_reason),
    // SYNTHESIZED: local models have no safety pipeline. Empty array is what
    // Gemini returns when nothing triggers.
    safetyRatings: [],
  };
  const out: GeminiResponse = {
    candidates: [candidate],
    modelVersion: resp.model,
  };
  if (resp.usage) {
    out.usageMetadata = {
      promptTokenCount: resp.usage.prompt_tokens,
      candidatesTokenCount: resp.usage.completion_tokens,
      totalTokenCount: resp.usage.total_tokens,
    };
  }
  return out;
}

/**
 * One OpenAI stream chunk -> one complete GenerateContentResponse for one
 * SSE event. Returns null for chunks that carry nothing representable
 * (e.g. the empty role-only preamble some servers send).
 */
export function openAIChunkToGeminiResponse(chunk: OpenAIStreamChunk): GeminiResponse | null {
  const choice = chunk.choices?.[0];
  // usage-only final frame (stream_options.include_usage)
  if (!choice) {
    if (chunk.usage) {
      return {
        usageMetadata: {
          promptTokenCount: chunk.usage.prompt_tokens,
          candidatesTokenCount: chunk.usage.completion_tokens,
          totalTokenCount: chunk.usage.total_tokens,
        },
      };
    }
    return null;
  }

  const parts: GeminiPart[] = [];
  if (choice.delta?.reasoning) parts.push({ text: choice.delta.reasoning, thought: true });
  if (choice.delta?.content) parts.push({ text: choice.delta.content });
  // Streaming tool-call deltas arrive as fragments of a JSON string; Gemini
  // streams functionCall parts whole. We only translate complete fragments
  // when finish arrives — for this prototype tool calls are exercised
  // non-streaming, and this is flagged as a lossy edge.

  const done = choice.finish_reason != null;
  if (!parts.length && !done && !chunk.usage) return null;

  const resp: GeminiResponse = {
    candidates: [
      {
        index: 0,
        content: { role: "model", parts: parts.length ? parts : [{ text: "" }] },
        ...(done ? { finishReason: mapFinishReason(choice.finish_reason) } : {}),
      },
    ],
  };
  if (chunk.usage) {
    resp.usageMetadata = {
      promptTokenCount: chunk.usage.prompt_tokens,
      candidatesTokenCount: chunk.usage.completion_tokens,
      totalTokenCount: chunk.usage.total_tokens,
    };
  }
  return resp;
}

// ---------- Error translation ----------

/**
 * Gemini-shaped error envelope. Mirrors the production 404 text pattern:
 *   "models/<name> is not found for API version v1beta, or is not supported
 *    for generateContent. Call ListModels to see the list of available models."
 */
export function geminiErrorEnvelope(status: number, message: string, statusText: string) {
  return {
    error: { code: status, message, status: statusText },
  };
}

export function modelNotFoundEnvelope(model: string) {
  return geminiErrorEnvelope(
    404,
    `models/${model} is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models.`,
    "NOT_FOUND"
  );
}

/** Format one SSE event the way @firebase/ai's stream-reader expects. */
export function sseEvent(resp: GeminiResponse): string {
  // NOTE: the SDK's responseLineRE is /^data\: (.*)(?:\n\n|...)/ and it
  // JSON.parses every event — emitting OpenAI's `data: [DONE]` sentinel
  // would crash it with PARSE_FAILED. Never forward it.
  return `data: ${JSON.stringify(resp)}\n\n`;
}
