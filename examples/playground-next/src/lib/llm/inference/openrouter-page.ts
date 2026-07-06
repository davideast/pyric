/**
 * In-repo page-direct OpenRouter provider — supersedes
 * `@inbrowser/relay/providers/openrouter` on the fallback transport.
 *
 * Why a fork exists (sonnet-food session, 2026-06-10):
 *
 *   1. **Bounded reasoning.** The relay provider sends
 *      `reasoning: { effort }` but NO `max_tokens`. OpenRouter maps
 *      Anthropic effort to `budget_tokens ≈ ratio × max_tokens`, and
 *      with max_tokens absent it falls back to the model-default cap —
 *      so `medium` on Claude Sonnet still authorized a ~60k-token
 *      thinking free-run (14 minutes before the first tool call). This
 *      provider always sends an explicit `max_tokens`, making the
 *      effort ratios mean what the picker says.
 *   2. **Anthropic thinking round-trip.** OpenRouter returns signed
 *      thinking blocks in `reasoning_details`
 *      (`{ type: 'reasoning.text', text, signature,
 *      format: 'anthropic-claude-v1' }` — probe-verified against
 *      claude-haiku-4.5). The relay provider drops them, so every ReAct
 *      iteration starts from amnesia and re-derives the design. This
 *      provider merges the streamed deltas, remembers them per tool
 *      callId, and re-attaches them verbatim on the assistant message
 *      when those calls are echoed back — the Anthropic sibling of the
 *      Gemini `thought_signature` path in
 *      `~/lib/experiment/local-openai-llm.ts`.
 *   3. **Reasoning-token telemetry.** Parses
 *      `usage.completion_tokens_details.reasoning_tokens` (and cached
 *      prompt tokens) so the playground can report what the thinking
 *      actually cost.
 *
 * Both transports use this module: the page-direct fallback
 * (inference/index.ts) and the server relay (server/relay.ts plugs it
 * into `createRelay({ providers })`). Already-deployed Cloud Functions
 * keep the old relay provider until redeployed. Items 1–3 above are
 * also the upstream fix spec for `@inbrowser/relay`'s own provider.
 */
import type { ModelMessage, ToolSpec, NormalizedRequest } from '@inbrowser/relay';
import { readSseDataLines } from '@inbrowser/relay';

/**
 * The playground's page-direct inference event — the flat wire shape the
 * in-repo providers (this module, `./claude-lane`, `./gemini`, `./ollama`)
 * all emit and the `CallbackProvider` wrappers (`~/lib/llm/*.ts`) consume.
 *
 * This was relay's own `InferenceEvent` through 0.3.x. Published
 * `@inbrowser/relay@0.4.0` re-homed the model-call contract in
 * `@inbrowser/model` as `ModelEvent` — a DIFFERENT shape (`text:` instead
 * of `chunk:`, a nested `usage` object). The playground keeps its flat
 * shape (it is its own page-direct contract, decoupled from the relay
 * transport), so the type now lives here rather than being imported.
 */
export type InferenceEvent =
  | { kind: 'text'; chunk: string }
  | { kind: 'thinking'; chunk: string }
  | { kind: 'tool_call'; callId: string; name: string; args: unknown; signature?: string }
  | { kind: 'usage'; promptTokens: number; outputTokens: number; cachedTokens?: number; reasoningTokens?: number; costUsd?: number }
  | { kind: 'error'; message: string };

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/** Bounds the per-iteration output (text + tool args + thinking). The
 *  effort → thinking-budget ratios (low 20% / medium 50% / high 80%)
 *  apply to THIS number, so medium ≈ 8k thinking tokens per iteration
 *  instead of "half of whatever the model maximum is". */
export const DEFAULT_MAX_TOKENS = 16384;

/**
 * User-configurable OpenRouter provider-routing controls (settings →
 * `NormalizedRequest.providerRouting` → `provider` wire field).
 *
 * Price-cap units: USD per MILLION tokens — per the provider-routing
 * docs (https://openrouter.ai/docs/guides/routing/provider-selection),
 * `max_price: {"prompt": 1, "completion": 2}` routes only to providers
 * charging ≤ $1/M prompt tokens and ≤ $2/M completion tokens. The UI's
 * "$/M tok" values therefore pass through unconverted.
 */
export interface ProviderRouting {
  /** Wire `provider.sort`; `default` (or absent) sends no sort field —
   *  OpenRouter's own price-biased, load-balanced routing. */
  sort?: 'throughput' | 'price' | 'latency' | 'default';
  /** Max provider price, USD per million PROMPT tokens. Unset = no cap. */
  maxPromptPrice?: number;
  /** Max provider price, USD per million COMPLETION tokens. */
  maxCompletionPrice?: number;
}

/** `NormalizedRequest` + the playground's routing controls. The extra
 *  field is optional and JSON-serializable, so it survives the server
 *  relay transport unchanged; relay-typed callers that never set it get
 *  the legacy throughput-sort behavior (see `buildProviderPrefs`). */
export type PageNormalizedRequest = NormalizedRequest & {
  providerRouting?: ProviderRouting;
};

/**
 * Build the wire `provider` preferences object, or `undefined` when
 * nothing is configured (sort `default` + no price caps) — in which
 * case the field is omitted entirely and OpenRouter routes its own way.
 *
 * An ABSENT `routing` (legacy caller that predates the knob, e.g. an
 * already-deployed relay) keeps the measured 2026-06-11 fix: sort by
 * throughput, no caps. Exported for tests.
 */
export function buildProviderPrefs(
  routing: ProviderRouting | undefined,
): Record<string, unknown> | undefined {
  const r = routing ?? { sort: 'throughput' };
  const prefs: Record<string, unknown> = {};
  if (r.sort && r.sort !== 'default') prefs.sort = r.sort;
  const maxPrice: Record<string, number> = {};
  if (typeof r.maxPromptPrice === 'number' && r.maxPromptPrice > 0) {
    maxPrice.prompt = r.maxPromptPrice;
  }
  if (typeof r.maxCompletionPrice === 'number' && r.maxCompletionPrice > 0) {
    maxPrice.completion = r.maxCompletionPrice;
  }
  if (Object.keys(maxPrice).length > 0) prefs.max_price = maxPrice;
  return Object.keys(prefs).length > 0 ? prefs : undefined;
}

/** One OpenRouter `reasoning_details` block (probe-verified). */
export interface ReasoningDetail {
  type: string;
  text?: string;
  data?: string;
  summary?: string;
  signature?: string;
  id?: string | null;
  format?: string;
  index?: number;
  [k: string]: unknown;
}

/** The page event union with the usage member widened — the base shape
 *  has no `reasoningTokens` slot. Base usage events remain assignable
 *  (the extra field is optional). */
export type PageInferenceEvent =
  | Exclude<InferenceEvent, { kind: 'usage' }>
  | {
      kind: 'usage';
      promptTokens: number;
      outputTokens: number;
      cachedTokens?: number;
      reasoningTokens?: number;
      costUsd?: number;
    };

/** A cacheable content part (OpenRouter/Anthropic prompt-caching
 *  breakpoint) — same shape as the experiment client's
 *  (`~/lib/experiment/local-openai-llm.ts`). */
export type ContentPart = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

interface OaiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | ContentPart[];
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
  reasoning_details?: ReasoningDetail[];
}

/**
 * callId → reasoning_details of the assistant turn that emitted the
 * call. Module-level (like the experiment client's thoughtSignatures
 * map) because the agent runtime's message records have no slot for
 * message-level reasoning blocks — the provider itself remembers them
 * across iterations. Bounded: cleared past ~200 entries (a turn rarely
 * exceeds a few dozen calls; entries are only useful within a session).
 */
const detailsByCallId = new Map<string, ReasoningDetail[]>();
const DETAILS_CAP = 200;

/** Test hook — reset the round-trip memory between cases. */
export function _resetReasoningDetails(): void {
  detailsByCallId.clear();
}

export function toOaiMessages(messages: ModelMessage[]): OaiMessage[] {
  const out: OaiMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'user') {
      out.push({ role: m.role, content: m.text ?? '' });
      continue;
    }
    if (m.role === 'assistant') {
      const msg: OaiMessage = { role: 'assistant', content: m.text ?? '' };
      if (m.toolCalls && m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: {
            name: c.name,
            arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}),
          },
        }));
        // OpenAI dislikes assistant messages with both empty content
        // and tool_calls present — null content is the documented form.
        if (!msg.content) msg.content = null;
        // Anthropic: re-attach the signed thinking blocks captured when
        // this turn was generated. OpenRouter requires the sequence
        // verbatim and unmodified; all of a turn's callIds map to the
        // same array, so the first hit wins.
        for (const c of m.toolCalls) {
          const rd = detailsByCallId.get(c.id);
          if (rd && rd.length > 0) {
            msg.reasoning_details = rd;
            break;
          }
        }
      }
      out.push(msg);
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId ?? '',
        name: m.name ?? '',
        content: m.resultJson ?? '',
      });
    }
  }
  return out;
}

function toOaiTools(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));
}

/**
 * Build the wire body. Exported for tests — the reasoning shape is the
 * defect-1 fix and must stay pinned.
 */
export function buildBody(req: PageNormalizedRequest): Record<string, unknown> {
  const effort = req.reasoningEffort ?? 'off';
  // Provider routing — sort (default THROUGHPUT, not price: default
  // routing lands on congested cheap providers, measured 2026-06-11 at
  // 19–63 tok/s effective vs 200 tok/s throughput-sorted) plus optional
  // price ceilings, both user-configurable via the settings modal.
  // `undefined` (sort 'default' + no caps) omits the field entirely.
  const providerPrefs = buildProviderPrefs(req.providerRouting);
  const messages = toOaiMessages(req.messages);
  // Prompt caching (#511, ported from the experiment client where it's
  // measured at 34–83% cache rates): put a `cache_control` breakpoint on
  // the static system prefix so the ~9k-token system prompt re-sent every
  // ReAct iteration bills as cached. Sent unconditionally — this provider
  // is OpenRouter-only, the same gating posture as `usage: { include }`.
  // Honored by Anthropic/Gemini/Kimi-style providers; ignored harmlessly
  // elsewhere. The string→parts conversion happens ONLY on the marked
  // message (some providers expect plain-string content everywhere else).
  if (messages[0]?.role === 'system' && typeof messages[0].content === 'string') {
    messages[0] = {
      role: 'system',
      content: [{ type: 'text', text: messages[0].content, cache_control: { type: 'ephemeral' } }],
    };
  }
  return {
    model: req.model,
    messages,
    stream: true,
    // Ask OpenRouter to include cost + cached-token telemetry in the
    // final usage chunk.
    usage: { include: true },
    ...(providerPrefs ? { provider: providerPrefs } : {}),
    // Explicit output cap — load-bearing for the reasoning budget (see
    // file header). Also bounds a runaway final answer.
    max_tokens: DEFAULT_MAX_TOKENS,
    ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
    ...(typeof req.topP === 'number' ? { top_p: req.topP } : {}),
    ...(typeof req.topK === 'number' ? { top_k: req.topK } : {}),
    // OpenRouter's unified reasoning parameter:
    //   - `effort: 'off'` → `reasoning: { enabled: false }`. Omitting
    //     the field does NOT disable reasoning on Anthropic / DeepSeek /
    //     GLM / Kimi / MiniMax thinking models — they fall back to the
    //     model-default budget.
    //   - low/medium/high → effort ratios of max_tokens (Anthropic:
    //     20/50/80%). `summary: 'auto'` is required for GPT-5 to
    //     surface reasoning deltas; `include_reasoning: true` is the
    //     legacy alias still honored by older proxy versions.
    ...(effort === 'off'
      ? { reasoning: { enabled: false } }
      : { reasoning: { effort, summary: 'auto' }, include_reasoning: true }),
    ...(req.tools.length > 0 ? { tools: toOaiTools(req.tools), tool_choice: 'auto' } : {}),
  };
}

/**
 * Merge one streamed `reasoning_details` delta into the accumulating
 * array. Deltas for the same block arrive with the same `index` —
 * text/data concatenates, signature/id/format land on whichever delta
 * carries them (the signature arrives on a final, text-less delta).
 * Exported for tests.
 */
export function mergeReasoningDelta(acc: Map<number, ReasoningDetail>, delta: ReasoningDetail): void {
  const idx = typeof delta.index === 'number' ? delta.index : acc.size === 0 ? 0 : Math.max(...acc.keys());
  const slot = acc.get(idx) ?? { type: delta.type };
  if (delta.type) slot.type = delta.type;
  if (typeof delta.text === 'string') slot.text = (slot.text ?? '') + delta.text;
  if (typeof delta.data === 'string') slot.data = (slot.data ?? '') + delta.data;
  if (typeof delta.summary === 'string') slot.summary = (slot.summary ?? '') + delta.summary;
  if (delta.signature) slot.signature = delta.signature;
  if (delta.id != null) slot.id = delta.id;
  if (delta.format) slot.format = delta.format;
  acc.set(idx, slot);
}

/** Flatten the merge accumulator into the wire-order array, dropping
 *  the streaming-only `index` field (echo must match the original
 *  message shape, which is index-less in non-streaming responses). */
export function mergedDetails(acc: Map<number, ReasoningDetail>): ReasoningDetail[] {
  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, d]) => d);
}

interface StreamDelta {
  content?: string;
  reasoning?: string;
  reasoning_content?: string;
  reasoning_details?: ReasoningDetail[];
  tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
}

interface StreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cache_read_input_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

export const openrouterPageProvider = async function* (
  req: PageNormalizedRequest,
): AsyncIterable<PageInferenceEvent> {
  const body = buildBody(req);

  const doFetch = (b: Record<string, unknown>) =>
    fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${req.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://pyric-playground.web.app',
        'X-Title': 'Pyric Playground',
      },
      body: JSON.stringify(b),
      ...(req.signal ? { signal: req.signal } : {}),
    });

  let response: Response;
  try {
    response = await doFetch(body);
    // Feature-detect `reasoning`: a model/provider that rejects the
    // parameter (4xx whose body names it) gets ONE retry without the
    // field — mirrors the `usage` gating posture: never let the knob
    // break a lane that worked without it.
    if (!response.ok && response.status >= 400 && response.status < 500 && 'reasoning' in body) {
      const errText = await response.text().catch(() => '');
      if (/reasoning/i.test(errText)) {
        const { reasoning: _drop, include_reasoning: _drop2, ...rest } = body;
        response = await doFetch(rest);
      } else {
        yield { kind: 'error', message: `OpenRouter ${response.status}: ${errText.slice(0, 240)}` };
        return;
      }
    }
  } catch (e) {
    if (req.signal?.aborted) return;
    yield { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    return;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    yield { kind: 'error', message: `OpenRouter ${response.status}: ${text.slice(0, 240)}` };
    return;
  }

  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens: number | undefined;
  let reasoningTokens: number | undefined;
  let costUsd: number | undefined;
  const pending = new Map<number, { id: string; name: string; args: string; emitted: boolean }>();
  const reasoningAcc = new Map<number, ReasoningDetail>();

  try {
    for await (const payload of readSseDataLines(response.body)) {
      if (payload === '[DONE]') break;
      if (req.signal?.aborted) return;
      let evt: unknown;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }
      const e = evt as { choices?: { delta?: StreamDelta }[]; usage?: StreamUsage };
      const delta = e.choices?.[0]?.delta;
      if (delta?.content) {
        yield { kind: 'text', chunk: delta.content };
      }
      const reasoning = delta?.reasoning ?? delta?.reasoning_content;
      if (reasoning) {
        yield { kind: 'thinking', chunk: reasoning };
      }
      if (Array.isArray(delta?.reasoning_details)) {
        for (const d of delta.reasoning_details) mergeReasoningDelta(reasoningAcc, d);
      }
      if (delta?.tool_calls) {
        for (const d of delta.tool_calls) {
          let p = pending.get(d.index);
          if (!p) {
            p = { id: d.id ?? '', name: '', args: '', emitted: false };
            pending.set(d.index, p);
          }
          if (d.id) p.id = d.id;
          if (d.function?.name) p.name = d.function.name;
          if (d.function?.arguments) p.args += d.function.arguments;
        }
      }
      if (e.usage) {
        promptTokens = e.usage.prompt_tokens ?? promptTokens;
        completionTokens = e.usage.completion_tokens ?? completionTokens;
        const cached = e.usage.prompt_tokens_details?.cached_tokens ?? e.usage.cache_read_input_tokens;
        if (typeof cached === 'number') cachedTokens = cached;
        const rt = e.usage.completion_tokens_details?.reasoning_tokens;
        if (typeof rt === 'number') reasoningTokens = rt;
        if (typeof e.usage.cost === 'number') costUsd = e.usage.cost;
      }
    }
  } catch (e) {
    if (req.signal?.aborted) return;
    yield { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    return;
  }

  // Tool calls are streamed argument-by-argument; we wait until the
  // stream closes before parsing + emitting so we don't fire on
  // half-parsed JSON.
  const details = mergedDetails(reasoningAcc);
  for (const p of pending.values()) {
    if (p.emitted) continue;
    let parsedArgs: unknown = {};
    try {
      parsedArgs = p.args ? JSON.parse(p.args) : {};
    } catch {
      parsedArgs = { _raw: p.args };
    }
    const callId = p.id || `or_${Math.random().toString(36).slice(2, 10)}`;
    // Remember this turn's thinking blocks under every callId it
    // emitted so the echo path can re-attach them (defect-2 fix).
    if (details.length > 0) {
      if (detailsByCallId.size > DETAILS_CAP) detailsByCallId.clear();
      detailsByCallId.set(callId, details);
    }
    yield { kind: 'tool_call', callId, name: p.name, args: parsedArgs };
    p.emitted = true;
  }

  yield {
    kind: 'usage',
    promptTokens,
    outputTokens: completionTokens,
    ...(typeof cachedTokens === 'number' ? { cachedTokens } : {}),
    ...(typeof reasoningTokens === 'number' ? { reasoningTokens } : {}),
    ...(typeof costUsd === 'number' ? { costUsd } : {}),
  };
};
