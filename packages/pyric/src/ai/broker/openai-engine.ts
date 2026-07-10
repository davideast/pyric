/**
 * The OpenAI AnswerEngine: Gemini wire in, OpenAI-compatible upstream
 * (Ollama, llama.cpp, any /v1/chat/completions) out, Gemini wire back.
 *
 * The translation core is LIFTED from the proven prototype
 * (docs/conformance/ai/prototype-translator/translator.ts, wayfinder #96 —
 * ran the full matrix against the real firebase/ai 2.12.0 SDK). Pure
 * functions stay pure and unit-testable; only `OpenAiEngine` does I/O.
 *
 * The five lossy edges the prototype pinned, all handled here:
 *   1. Gemini functionResponse has no tool_call_id → synthesized FIFO id
 *      matching per function name ({@link geminiToOpenAIRequest}).
 *   2. OpenAI streams tool-call ARGUMENT FRAGMENTS; Gemini streams WHOLE
 *      functionCall parts → {@link ToolCallBuffer} accumulates fragments and
 *      the engine emits whole parts on the finish chunk.
 *   3. Never forward OpenAI's `data: [DONE]` sentinel — the SDK JSON.parses
 *      every event and dies with PARSE_FAILED (engine skips it).
 *   4. Thought parts are SKIPPED when replaying history to OpenAI
 *      (`part.thought` filter in the request walk).
 *   5. thoughtSignature has no OpenAI equivalent → minted on the Gemini
 *      side by the synthesizer's decoration pass (production signs even
 *      trivial text parts, and rejects unsigned functionCall turns).
 *
 * Plus: `content_filter` maps to SAFETY (faithful — makes response.text()
 * throw exactly like production).
 */

import {
  AiBrokerError,
  Synthesizer,
  errorEnvelope,
  estimateTokens,
  resolveModelVersion,
} from './synthesizer.js';
import { promptTextOf } from './scripted-engine.js';
import type {
  AnswerEngine,
  CountTokensRequest,
  CountTokensResponse,
  GenerateContentRequest,
  WireChunk,
  WirePart,
  WireResponse,
} from './types.js';

// ── OpenAI-side wire types (minimal) ────────────────────────────────────────

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  tools?: Array<{ type: 'function'; function: Record<string, unknown> }>;
  tool_choice?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  response_format?:
    | { type: 'json_object' }
    | {
        type: 'json_schema';
        json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean };
      };
  frequency_penalty?: number;
  presence_penalty?: number;
}

export interface OpenAIResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: OpenAIToolCall[];
      reasoning?: string;
    };
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

// ── Request translation: Gemini → OpenAI (pure) ─────────────────────────────

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
  req: GenerateContentRequest,
  stream: boolean,
): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  // systemInstruction -> leading system message
  if (req.systemInstruction) {
    const text = (req.systemInstruction.parts ?? []).map((p) => p.text ?? '').join('');
    if (text) messages.push({ role: 'system', content: text });
  }

  // Walk contents. Track pending tool-call ids per function name so a later
  // functionResponse turn can reference the right id.
  const pendingIdsByName = new Map<string, string[]>();
  let callOrdinal = 0;

  for (const content of req.contents ?? []) {
    if (content.role === 'function') {
      // functionResponse turn -> one OpenAI `tool` message per part
      for (const part of content.parts) {
        if (!part.functionResponse) continue;
        const queue = pendingIdsByName.get(part.functionResponse.name) ?? [];
        const id = queue.shift() ?? synthToolCallId(part.functionResponse.name, callOrdinal++);
        messages.push({
          role: 'tool',
          tool_call_id: id,
          content: JSON.stringify(part.functionResponse.response),
        });
      }
      continue;
    }

    const role = content.role === 'model' ? 'assistant' : 'user';
    const textParts: string[] = [];
    const toolCalls: OpenAIToolCall[] = [];

    for (const part of content.parts) {
      // LOSSY EDGE: thought parts must not be replayed to OpenAI as
      // assistant text; real Gemini also does not accept thought text back
      // (only thoughtSignatures — which have no OpenAI equivalent and drop).
      if (part.thought) continue;
      if (typeof part.text === 'string') {
        textParts.push(part.text);
      } else if (part.functionCall) {
        const id = synthToolCallId(part.functionCall.name, callOrdinal++);
        const queue = pendingIdsByName.get(part.functionCall.name) ?? [];
        queue.push(id);
        pendingIdsByName.set(part.functionCall.name, queue);
        toolCalls.push({
          id,
          type: 'function',
          // LOSSY EDGE: Gemini args is an object; OpenAI wants a JSON string.
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          },
        });
      } else if (part.inlineData) {
        // Not exercised by the V1 broker; marked gap carried from the prototype.
        textParts.push(`[unsupported inlineData part: ${part.inlineData.mimeType}]`);
      }
    }

    const msg: OpenAIMessage = {
      role,
      content: textParts.length ? textParts.join('') : null,
    };
    if (toolCalls.length) msg.tool_calls = toolCalls;
    messages.push(msg);
  }

  const out: OpenAIRequest = { model, messages, stream };
  if (stream) out.stream_options = { include_usage: true };

  // tools
  const decls = (req.tools ?? []).flatMap((t) => t.functionDeclarations ?? []);
  if (decls.length) {
    out.tools = decls.map((d) => ({
      type: 'function',
      function: {
        name: d.name,
        description: d.description,
        parameters: normalizeSchema(d.parameters) ?? { type: 'object', properties: {} },
      },
    }));
  }

  // toolConfig.mode -> tool_choice
  const mode = req.toolConfig?.functionCallingConfig?.mode;
  if (mode === 'ANY') out.tool_choice = 'required';
  else if (mode === 'NONE') out.tool_choice = 'none';
  else if (mode === 'AUTO') out.tool_choice = 'auto';

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
    if (g.responseMimeType === 'application/json') {
      out.response_format = g.responseSchema
        ? {
            type: 'json_schema',
            json_schema: {
              name: 'response',
              schema: normalizeSchema(g.responseSchema)!,
              strict: true,
            },
          }
        : { type: 'json_object' };
    }
  }

  return out;
}

/**
 * Gemini schemas allow uppercase type names ("STRING") and a `nullable`
 * flag; OpenAI/JSON-Schema wants lowercase types. Normalize defensively and
 * strip fields JSON Schema validators reject.
 */
export function normalizeSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const s = { ...(schema as Record<string, unknown>) };
  if (typeof s.type === 'string') s.type = (s.type as string).toLowerCase();
  delete s.nullable;
  if (s.properties && typeof s.properties === 'object') {
    s.properties = Object.fromEntries(
      Object.entries(s.properties as Record<string, unknown>).map(([k, v]) => [
        k,
        normalizeSchema(v),
      ]),
    );
  }
  if (s.items) s.items = normalizeSchema(s.items);
  return s;
}

// ── Response translation: OpenAI → Gemini (pure) ────────────────────────────

const FINISH_REASON_MAP: Record<string, string> = {
  stop: 'STOP',
  length: 'MAX_TOKENS',
  // A tool call is a normal, expected stop in Gemini's model; mapping to
  // anything in badFinishReasons would make the SDK throw on response.text().
  tool_calls: 'STOP',
  // Faithful mapping: SAFETY makes the SDK's response.text() throw — exactly
  // the real backend's behavior for filtered content.
  content_filter: 'SAFETY',
};

export function mapFinishReason(reason: string | null | undefined): string {
  if (!reason) return 'STOP';
  return FINISH_REASON_MAP[reason] ?? 'OTHER';
}

function messagePartsFromOpenAI(msg: {
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  reasoning?: string;
}): WirePart[] {
  const parts: WirePart[] = [];
  // Ollama's OpenAI compat surfaces thinking-model output in a nonstandard
  // `reasoning` field; Gemini represents it as a thought part.
  if (msg.reasoning) parts.push({ text: msg.reasoning, thought: true });
  if (msg.content) parts.push({ text: msg.content });
  for (const tc of msg.tool_calls ?? []) {
    let args: Record<string, unknown> = {};
    try {
      // LOSSY EDGE in reverse: OpenAI arguments is a JSON *string*; Gemini
      // wants an object.
      args = JSON.parse(tc.function.arguments || '{}');
    } catch {
      args = { __malformed: tc.function.arguments };
    }
    parts.push({ functionCall: { name: tc.function.name, args } });
  }
  if (!parts.length) parts.push({ text: '' });
  return parts;
}

export function openAIToGeminiResponse(resp: OpenAIResponse): WireResponse {
  const choice = resp.choices[0]!;
  const malformedToolArgs = (choice.message.tool_calls ?? []).some((tc) => {
    try {
      JSON.parse(tc.function.arguments || '{}');
      return false;
    } catch {
      return true;
    }
  });
  const out: WireResponse = {
    candidates: [
      {
        index: 0,
        content: { role: 'model', parts: messagePartsFromOpenAI(choice.message) },
        finishReason: malformedToolArgs
          ? 'MALFORMED_FUNCTION_CALL'
          : mapFinishReason(choice.finish_reason),
      },
    ],
  };
  if (resp.usage) {
    // Upstream-faithful counts only; the synthesizer's decorate pass adds the
    // synthesized promptTokensDetails/serviceTier decoration.
    out.usageMetadata = {
      promptTokenCount: resp.usage.prompt_tokens,
      candidatesTokenCount: resp.usage.completion_tokens,
      totalTokenCount: resp.usage.total_tokens,
    };
  }
  return out;
}

/**
 * One OpenAI stream chunk → the TEXT parts of one Gemini chunk (or null for
 * frames carrying nothing representable). Tool-call fragments are NOT
 * handled here — they buffer in {@link ToolCallBuffer} and emit whole on the
 * finish chunk (lossy edge #2).
 */
export function openAIChunkToParts(chunk: OpenAIStreamChunk): WirePart[] {
  const choice = chunk.choices?.[0];
  const parts: WirePart[] = [];
  if (choice?.delta?.reasoning) parts.push({ text: choice.delta.reasoning, thought: true });
  if (choice?.delta?.content) parts.push({ text: choice.delta.content });
  return parts;
}

/**
 * Accumulates OpenAI streamed tool-call fragments (indexed deltas whose
 * `arguments` arrive as string pieces) into whole Gemini functionCall parts.
 */
export class ToolCallBuffer {
  private readonly byIndex = new Map<number, { name: string; args: string }>();

  add(deltas: Array<Partial<OpenAIToolCall> & { index: number }> | undefined): void {
    for (const d of deltas ?? []) {
      const slot = this.byIndex.get(d.index) ?? { name: '', args: '' };
      if (d.function?.name) slot.name += d.function.name;
      if (d.function?.arguments) slot.args += d.function.arguments;
      this.byIndex.set(d.index, slot);
    }
  }

  get size(): number {
    return this.byIndex.size;
  }

  /** Emit whole functionCall parts (args parsed to an object) and reset. */
  flush(): WirePart[] {
    const parts: WirePart[] = [];
    const indexes = [...this.byIndex.keys()].sort((a, b) => a - b);
    for (const i of indexes) {
      const { name, args } = this.byIndex.get(i)!;
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(args || '{}');
      } catch {
        parsed = { __malformed: args };
      }
      parts.push({ functionCall: { name, args: parsed } });
    }
    this.byIndex.clear();
    return parts;
  }
}

// ── SSE parsing (pure, incremental) ─────────────────────────────────────────

/**
 * Incremental SSE `data:` payload extractor. Push decoded text as it
 * arrives; get back complete event payload strings. Handles both LF LF and
 * CRLF CRLF separators. Emits the `[DONE]` sentinel verbatim — CALLERS must
 * skip it (lossy edge #3); the engine never forwards it downstream.
 */
export class SseParser {
  private buffer = '';

  push(text: string): string[] {
    this.buffer += text;
    const payloads: string[] = [];
    for (;;) {
      const lf = this.buffer.indexOf('\n\n');
      const crlf = this.buffer.indexOf('\r\n\r\n');
      const at = lf === -1 ? crlf : crlf === -1 ? lf : Math.min(lf, crlf);
      if (at === -1) break;
      const sepLen = at === crlf && crlf !== -1 && (lf === -1 || crlf < lf) ? 4 : 2;
      const rawEvent = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + sepLen);
      for (const line of rawEvent.split(/\r?\n/)) {
        if (line.startsWith('data: ')) payloads.push(line.slice('data: '.length));
        else if (line.startsWith('data:')) payloads.push(line.slice('data:'.length));
      }
    }
    return payloads;
  }
}

export const DONE_SENTINEL = '[DONE]';

// ── The engine ──────────────────────────────────────────────────────────────

export interface OpenAiEngineOptions {
  baseUrl: string;
  model?: string;
  modelMap?: Record<string, string>;
  fetch?: typeof fetch;
  synthesizer?: Synthesizer;
}

export class OpenAiEngine implements AnswerEngine {
  private readonly baseUrl: string;
  private readonly defaultModel: string | undefined;
  private readonly modelMap: Record<string, string>;
  /** Call-signature only (not `typeof fetch`): the wrapper below carries none
   *  of the runtime's static props (e.g. Bun's `fetch.preconnect`). */
  private readonly fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly synth: Synthesizer;

  constructor(options: OpenAiEngineOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.defaultModel = options.model;
    this.modelMap = options.modelMap ?? {};
    // Wrapped, not stored bare: `this.fetchImpl(...)` would otherwise invoke
    // the global fetch with the engine as its receiver, an Illegal invocation
    // in browser/worker contexts (Node tolerates it, browsers do not).
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.synth = options.synthesizer ?? new Synthesizer();
  }

  /** Gemini model id → upstream model: modelMap[model] ?? config.model ?? passthrough. */
  resolveUpstreamModel(model: string): string {
    const bare = model.startsWith('models/') ? model.slice('models/'.length) : model;
    return this.modelMap[bare] ?? this.modelMap[model] ?? this.defaultModel ?? bare;
  }

  async generateContent(req: GenerateContentRequest, model: string): Promise<WireResponse> {
    const body = geminiToOpenAIRequest(this.resolveUpstreamModel(model), req, false);
    const res = await this.post(body);
    const upstream = (await res.json()) as OpenAIResponse;
    const translated = openAIToGeminiResponse(upstream);
    return this.synth.decorate(translated, { model, promptText: promptTextOf(req) });
  }

  streamGenerateContent(req: GenerateContentRequest, model: string): AsyncIterable<WireChunk> {
    const body = geminiToOpenAIRequest(this.resolveUpstreamModel(model), req, true);
    const opts = { model, promptText: promptTextOf(req) };
    const synth = this.synth;
    const post = () => this.post(body);

    return (async function* stream(): AsyncGenerator<WireChunk> {
      const res = await post();
      if (!res.body) throw new AiBrokerError(errorEnvelope(502, 'upstream returned no body', 'UNAVAILABLE'));

      const modelVersion = resolveModelVersion(model);
      const responseId = synth.nextResponseId();
      const promptTokenCount = estimateTokens(opts.promptText);
      const toolBuffer = new ToolCallBuffer();
      const parser = new SseParser();
      const decoder = new TextDecoder();
      let emittedText = '';
      let upstreamUsage: OpenAIStreamChunk['usage'];
      let pendingFinish: string | null = null;

      /**
       * Frame one complete Gemini chunk. Wire-true semantics require
       * usageMetadata on EVERY chunk, but OpenAI upstreams only send usage on
       * the final frame (stream_options.include_usage) — so interim chunks
       * carry synthesized estimates (by-design synthesized decoration,
       * cdd-deltas #99.2) and the finish chunk uses real upstream numbers
       * when they arrived.
       */
      function frame(parts: WirePart[], finishReason?: string): WireChunk {
        const candidatesTokenCount = estimateTokens(emittedText);
        const usage = upstreamUsage
          ? {
              promptTokenCount: upstreamUsage.prompt_tokens,
              candidatesTokenCount: upstreamUsage.completion_tokens,
              totalTokenCount: upstreamUsage.total_tokens,
            }
          : {
              promptTokenCount,
              candidatesTokenCount,
              totalTokenCount: promptTokenCount + candidatesTokenCount,
            };
        return {
          candidates: [
            {
              content: { parts: parts.length ? parts : [{ text: '' }], role: 'model' },
              ...(finishReason ? { finishReason } : {}),
              index: 0,
            },
          ],
          usageMetadata: {
            ...usage,
            promptTokensDetails: [{ modality: 'TEXT', tokenCount: usage.promptTokenCount }],
            serviceTier: 'standard',
          },
          modelVersion,
          responseId,
        };
      }

      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          const payloads = done
            ? parser.push('\n\n') // flush any trailing buffered event
            : parser.push(decoder.decode(value, { stream: true }));

          for (const payload of payloads) {
            // LOSSY EDGE: never forward the [DONE] sentinel.
            if (payload.trim() === DONE_SENTINEL) continue;
            let chunk: OpenAIStreamChunk;
            try {
              chunk = JSON.parse(payload) as OpenAIStreamChunk;
            } catch {
              continue; // non-JSON keepalive/comment frames
            }
            if (chunk.usage) upstreamUsage = chunk.usage;
            const choice = chunk.choices?.[0];
            if (!choice) continue; // usage-only final frame folds into the finish chunk

            toolBuffer.add(choice.delta?.tool_calls);
            const parts = openAIChunkToParts(chunk);
            emittedText += parts.map((p) => (p.thought ? '' : (p.text ?? ''))).join('');

            if (choice.finish_reason != null) {
              pendingFinish = choice.finish_reason;
              // Hold the finish frame until the reader drains, so a trailing
              // usage-only frame (stream_options.include_usage) lands in it.
              if (parts.length) yield frame(parts);
              continue;
            }
            if (parts.length) yield frame(parts);
          }

          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }

      // The stream always ends with ONE finishing chunk (mirrors the captured
      // final frame: empty text part, signed, finishReason present).
      // LOSSY EDGE: buffered tool-call fragments emit here as WHOLE
      // functionCall parts, exactly once.
      const flushed = toolBuffer.flush();
      const finalParts = synth.signParts(flushed.length ? flushed : [{ text: '' }]);
      yield frame(finalParts, mapFinishReason(pendingFinish));
    })();
  }

  /** No OpenAI equivalent — deterministic synthesized estimate, wire-true envelope. */
  async countTokens(req: CountTokensRequest, _model: string): Promise<CountTokensResponse> {
    return this.synth.countTokens(promptTextOf(req));
  }

  private async post(body: OpenAIRequest): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new AiBrokerError(
        errorEnvelope(502, `openai engine: upstream fetch failed: ${String(err)}`, 'UNAVAILABLE'),
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AiBrokerError(
        errorEnvelope(
          res.status,
          `openai engine: upstream ${res.status}: ${text.slice(0, 500)}`,
          res.status === 404 ? 'NOT_FOUND' : 'INVALID_ARGUMENT',
        ),
      );
    }
    return res;
  }
}
