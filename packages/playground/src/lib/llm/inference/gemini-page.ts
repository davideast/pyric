/**
 * In-repo page-direct Gemini provider — raw fetch against the
 * Generative Language REST API, parsing SSE directly, emitting the
 * playground's flat `InferenceEvent` stream.
 *
 * This was `@inbrowser/relay/providers/gemini` through 0.3.x. Published
 * `@inbrowser/relay@0.4.0` moved the cloud providers into
 * `@inbrowser/model` as `ModelClient` factories (a different event
 * shape, nested usage), and `@inbrowser/model` is not a playground
 * dependency. So — as with `./openrouter-page` — the provider lives
 * in-repo, ported to the flat page-direct contract.
 *
 * Endpoint: POST .../models/{model}:streamGenerateContent?alt=sse
 *
 * Streamed function calls are accumulated across chunks and emitted
 * exactly once: Gemini re-sends the growing `content.parts[]` list every
 * chunk, so emitting a `tool_call` per chunk would duplicate every call.
 */
import { readSseDataLines } from '@inbrowser/relay';
import type { NormalizedRequest } from '@inbrowser/relay';
import type { InferenceEvent } from './openrouter-page';

const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: { result: unknown } };
}

interface GeminiBody {
  contents: GeminiContent[];
  systemInstruction?: { parts: { text: string }[] };
  tools?: { functionDeclarations: unknown[] }[];
  generationConfig?: Record<string, unknown>;
}

const GEMINI_25_THINKING_BUDGET = {
  low: 1024,
  medium: 4096,
  high: 8192,
} as const;

export function buildGeminiThinkingConfig(
  model: string,
  effort: NormalizedRequest['reasoningEffort'],
): Record<string, unknown> | undefined {
  if (!effort || effort === 'off') return undefined;
  const thinkingConfig: Record<string, unknown> = { includeThoughts: true };
  const normalized = model.toLowerCase();
  if (normalized.includes('gemini-3.5-') || normalized.includes('gemini-3-flash')) {
    thinkingConfig.thinkingLevel = effort;
  } else if (normalized.includes('gemini-2.5-')) {
    thinkingConfig.thinkingBudget = GEMINI_25_THINKING_BUDGET[effort];
  }
  return thinkingConfig;
}

function toGeminiBody(req: NormalizedRequest): GeminiBody {
  const contents: GeminiContent[] = [];
  let systemText = '';

  for (const m of req.messages) {
    if (m.role === 'system') {
      systemText += (systemText ? '\n\n' : '') + (m.text ?? '');
      continue;
    }
    if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: m.text ?? '' }] });
      continue;
    }
    if (m.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (m.text) parts.push({ text: m.text });
      for (const c of m.toolCalls ?? []) {
        // Gemini 3: `thoughtSignature` is a sibling of `functionCall`
        // on the part, NOT a child. Echoing it elsewhere returns
        // INVALID_ARGUMENT.
        const part: GeminiPart = {
          functionCall: {
            name: c.name,
            args: (c.args as Record<string, unknown>) ?? {},
          },
        };
        if (c.signature) part.thoughtSignature = c.signature;
        parts.push(part);
      }
      if (parts.length > 0) contents.push({ role: 'model', parts });
      continue;
    }
    if (m.role === 'tool') {
      let parsed: unknown = null;
      try {
        if (m.resultJson) parsed = JSON.parse(m.resultJson);
      } catch {
        parsed = m.resultJson;
      }
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: m.name ?? 'tool',
              response: { result: parsed },
            },
          },
        ],
      });
    }
  }

  const body: GeminiBody = { contents };
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };

  if (req.tools.length > 0) {
    const functionDeclarations = req.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: sanitizeGeminiSchema(t.function.parameters),
    }));
    body.tools = [{ functionDeclarations }];
  }

  const gen: Record<string, unknown> = {
    // Generous output budget — a truncated tool-call argument is exactly
    // what Gemini then rejects as MALFORMED_FUNCTION_CALL. 65536 is the
    // Gemini 3 family max, so this never reduces a model's default.
    maxOutputTokens: 65536,
  };
  const thinkingConfig = buildGeminiThinkingConfig(req.model, req.reasoningEffort);
  if (thinkingConfig) gen.thinkingConfig = thinkingConfig;
  if (typeof req.temperature === 'number') gen.temperature = req.temperature;
  if (typeof req.topP === 'number') gen.topP = req.topP;
  if (typeof req.topK === 'number') gen.topK = req.topK;
  body.generationConfig = gen;

  return body;
}

interface GeminiStreamChunk {
  candidates?: {
    content?: { role?: string; parts?: GeminiPart[] };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    // Thinking tokens — Gemini reports these SEPARATELY from
    // candidatesTokenCount, so without surfacing it the (often large)
    // cost of a thinking pass is invisible in the turn's usage.
    thoughtsTokenCount?: number;
  };
}

interface PendingGeminiCall {
  name: string;
  args: Record<string, unknown>;
  signature?: string;
}

function buildGeminiRequest(req: NormalizedRequest): Request {
  const url = `${ENDPOINT_BASE}/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`;
  return new Request(url, {
    method: 'POST',
    headers: {
      'x-goog-api-key': req.apiKey ?? '',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(toGeminiBody(req)),
  });
}

function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as Error & { cause?: unknown }).cause;
  if (cause == null) return e.message;
  let causeStr: string;
  if (cause instanceof Error) {
    causeStr = cause.message ? `${cause.name}: ${cause.message}` : cause.name;
  } else if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    causeStr = String((cause as { code: unknown }).code);
  } else {
    causeStr = String(cause);
  }
  return `${e.message} (${causeStr})`;
}

export async function* geminiEventsFromResponse(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<InferenceEvent> {
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    yield { kind: 'error', message: `Gemini ${response.status}: ${text.slice(0, 240)}` };
    return;
  }

  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let thinkingTokens = 0;
  let sawThinking = false;
  let sawVisibleText = false;
  let sawFunctionCall = false;
  let lastFinishReason: string | undefined;
  const pending = new Map<number, PendingGeminiCall>();

  try {
    for await (const payload of readSseDataLines(response.body)) {
      if (signal?.aborted) return;
      let chunk: GeminiStreamChunk;
      try {
        chunk = JSON.parse(payload) as GeminiStreamChunk;
      } catch {
        continue;
      }
      const parts = chunk.candidates?.[0]?.content?.parts ?? [];
      let fnOrdinal = 0;
      for (const p of parts) {
        if (typeof p.text === 'string' && p.text.length > 0) {
          if (p.thought === true || (p.thoughtSignature && !p.functionCall)) {
            sawThinking = true;
            yield { kind: 'thinking', chunk: p.text };
          } else {
            sawVisibleText = true;
            yield { kind: 'text', chunk: p.text };
          }
        }
        if (p.functionCall) {
          sawFunctionCall = true;
          const slot = fnOrdinal++;
          let call = pending.get(slot);
          if (!call) {
            call = { name: '', args: {} };
            pending.set(slot, call);
          }
          if (p.functionCall.name) call.name = p.functionCall.name;
          const incomingArgs = p.functionCall.args;
          if (
            incomingArgs &&
            typeof incomingArgs === 'object' &&
            !Array.isArray(incomingArgs) &&
            Object.keys(incomingArgs).length > 0
          ) {
            call.args = incomingArgs;
          }
          if (p.thoughtSignature) call.signature = p.thoughtSignature;
        }
      }
      const finishReason = chunk.candidates?.[0]?.finishReason;
      if (finishReason) lastFinishReason = finishReason;
      const usage = chunk.usageMetadata;
      if (usage) {
        promptTokens = usage.promptTokenCount ?? promptTokens;
        completionTokens = usage.candidatesTokenCount ?? completionTokens;
        if (typeof usage.cachedContentTokenCount === 'number') {
          cachedTokens = usage.cachedContentTokenCount;
        }
        if (typeof usage.thoughtsTokenCount === 'number') {
          thinkingTokens = usage.thoughtsTokenCount;
        }
      }
    }
  } catch (e) {
    if (signal?.aborted) return;
    yield { kind: 'error', message: describeError(e) };
    return;
  }

  if (!sawVisibleText && !sawFunctionCall) {
    yield geminiNoOutputError({
      finishReason: lastFinishReason,
      sawThinking,
      sawVisibleText,
      sawFunctionCall,
    });
    return;
  }

  for (const [slot, call] of pending) {
    if (!call.name) continue;
    yield {
      kind: 'tool_call',
      callId: `gem_${slot}`,
      name: call.name,
      args: call.args,
      ...(call.signature ? { signature: call.signature } : {}),
    };
  }

  yield {
    kind: 'usage',
    promptTokens,
    outputTokens: completionTokens,
    ...(cachedTokens > 0 ? { cachedTokens } : {}),
    ...(thinkingTokens > 0 ? { reasoningTokens: thinkingTokens } : {}),
  };
}

const MAX_GEMINI_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

const RETRYABLE_ERROR_MARKERS = [
  'MALFORMED_FUNCTION_CALL',
  'finishReason=STOP',
  'finishReason=none',
];

type ErrorInferenceEvent = Extract<InferenceEvent, { kind: 'error' }>;

function geminiNoOutputError(opts: {
  finishReason?: string;
  sawThinking: boolean;
  sawVisibleText: boolean;
  sawFunctionCall: boolean;
}): ErrorInferenceEvent {
  const finishReason = opts.finishReason ?? 'none';
  const message = `Gemini produced no output — finishReason=${finishReason} (${
    opts.sawThinking ? 'response ended after thinking only' : 'response ended with no visible output'
  })`;
  let code = 'gemini.no_output';
  let retryable = false;
  if (opts.finishReason === undefined) {
    code = 'gemini.truncated_no_output';
    retryable = true;
  } else if (opts.finishReason === 'MALFORMED_FUNCTION_CALL') {
    code = 'gemini.malformed_function_call';
    retryable = true;
  } else if (opts.finishReason === 'STOP' && opts.sawThinking) {
    code = 'gemini.thinking_only_stop';
    retryable = true;
  }
  return {
    kind: 'error',
    message,
    code,
    retryable,
    details: {
      finishReason,
      sawThinking: opts.sawThinking,
      sawVisibleText: opts.sawVisibleText,
      sawFunctionCall: opts.sawFunctionCall,
    },
  };
}

function isRetryableError(event: ErrorInferenceEvent): boolean {
  if (event.retryable === true) return true;
  if (event.retryable === false) return false;
  return RETRYABLE_ERROR_MARKERS.some((m) => event.message.includes(m));
}

function withAttemptMetadata(
  event: ErrorInferenceEvent,
  attempt: number,
  maxAttempts: number,
): ErrorInferenceEvent {
  return {
    ...event,
    details: {
      ...(event.details ?? {}),
      attempt,
      maxAttempts,
    },
  };
}

/**
 * Page-direct Gemini provider. Retries a small set of transient
 * failures (malformed function call, thinking-only finishReason=STOP,
 * truncated stream) up to 3 attempts; deterministic failures (SAFETY,
 * RECITATION, MAX_TOKENS, network) fall straight through.
 */
export const geminiProvider = async function* (
  req: NormalizedRequest,
): AsyncIterable<InferenceEvent> {
  const signal = req.signal;
  for (let attempt = 1; attempt <= MAX_GEMINI_ATTEMPTS; attempt++) {
    if (signal?.aborted) return;
    const request = buildGeminiRequest(req);

    let response: Response;
    try {
      response = await fetch(request, signal ? { signal } : {});
    } catch (e) {
      if (signal?.aborted) return;
      yield { kind: 'error', message: describeError(e) };
      return;
    }

    let retry = false;
    for await (const evt of geminiEventsFromResponse(response, signal)) {
      if (evt.kind === 'error' && isRetryableError(evt) && attempt < MAX_GEMINI_ATTEMPTS) {
        retry = true;
        break;
      }
      yield evt.kind === 'error' ? withAttemptMetadata(evt, attempt, MAX_GEMINI_ATTEMPTS) : evt;
    }

    if (!retry) return;
    try {
      await response.body?.cancel();
    } catch {
      /* already released — fine */
    }
    if (signal?.aborted) return;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
};

const STRIP_KEYS = new Set(['additionalProperties', '$schema', '$ref', '$defs', 'definitions']);

export function sanitizeGeminiSchema(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(sanitizeGeminiSchema);
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (STRIP_KEYS.has(k)) continue;
      out[k] = sanitizeGeminiSchema(v);
    }
    return out;
  }
  return node;
}
