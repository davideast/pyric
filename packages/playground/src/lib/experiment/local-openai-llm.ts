/**
 * `localOpenAiLlm` — a `ModelClient` for any OpenAI-compatible local server
 * (llama.cpp `llama-server`, Ollama's `/v1`, LM Studio, vLLM, …).
 *
 * Lets the strategy experiment run against a model on localhost: real
 * inference, zero API spend, no key. Non-streaming (the eval harness wants
 * the final answer + usage, not live tokens), and it forwards tool
 * declarations so the ReAct arms can tool-call when the local model
 * supports it. The draft-validate arm needs no model tool-calls (dispatch
 * is host-driven), so it works even against a tool-call-incapable server.
 *
 * Node-safe (plain fetch). Used by scripts/run-experiment.ts --local.
 */
import type { ModelClient } from '@inbrowser/agent';

/** A cacheable content part (OpenRouter/Anthropic prompt-caching breakpoint). */
type ContentPart = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

/**
 * One OpenRouter `reasoning_details` block (probe-verified against
 * `anthropic/claude-haiku-4.5`, 2026-06-10). Anthropic thinking comes
 * back as `{ type: 'reasoning.text', text, signature,
 * format: 'anthropic-claude-v1' }`; redacted thinking arrives as
 * `{ type: 'reasoning.encrypted', data }`. The whole array must be
 * echoed back VERBATIM on the assistant message when its tool calls
 * appear in history — that is how the model's thinking context
 * survives across ReAct iterations.
 */
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

interface OaiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | ContentPart[];
  tool_calls?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
    /** Gemini-3 (OpenAI-compat) thinking models REQUIRE the
     *  thought_signature returned with a function call to be echoed
     *  back verbatim when the call appears in history. */
    extra_content?: { google: { thought_signature: string } };
  }[];
  tool_call_id?: string;
  /** Anthropic (via OpenRouter): signed thinking blocks re-attached
   *  on echo — the sibling of Gemini's thought_signature. */
  reasoning_details?: ReasoningDetail[];
}

interface NormMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  text?: string;
  toolCalls?: { callId?: string; id?: string; name: string; args: unknown; signature?: string }[];
  /** ModelMessage names the tool-result correlation field `toolCallId`;
   *  `callId` is tolerated for older callers. */
  toolCallId?: string;
  callId?: string;
  name?: string;
  resultJson?: string;
}

function toOai(
  messages: readonly NormMsg[],
  thoughtSignatures?: ReadonlyMap<string, string>,
  reasoningDetails?: ReadonlyMap<string, ReasoningDetail[]>,
): OaiMessage[] {
  const out: OaiMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'user') {
      out.push({ role: m.role, content: m.text ?? '' });
    } else if (m.role === 'assistant') {
      const msg: OaiMessage = { role: 'assistant', content: m.text ?? '' };
      if (m.toolCalls && m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map((c) => {
          const id = c.callId ?? c.id ?? '';
          const sig = c.signature ?? thoughtSignatures?.get(id);
          return {
            id,
            type: 'function' as const,
            function: {
              name: c.name,
              arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}),
            },
            ...(sig ? { extra_content: { google: { thought_signature: sig } } } : {}),
          };
        });
        if (!msg.content) msg.content = null; // OpenAI wants null content with tool_calls
        // Anthropic (via OpenRouter): re-attach the signed thinking
        // blocks captured when this assistant turn was generated, so
        // the model's reasoning context survives the next iteration.
        // Keyed per callId — one assistant turn's calls all map to the
        // same array, so the first hit wins.
        for (const c of m.toolCalls) {
          const rd = reasoningDetails?.get(c.callId ?? c.id ?? '');
          if (rd && rd.length > 0) {
            msg.reasoning_details = rd;
            break;
          }
        }
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId ?? m.callId ?? '', content: m.resultJson ?? '' });
    }
  }
  return out;
}

export interface LocalLlmOptions {
  /** OpenAI-compatible base URL, e.g. http://localhost:8080/v1 */
  baseUrl: string;
  /** Model id the server expects. */
  model: string;
  /** Optional temperature (default left to the server). */
  temperature?: number;
  /** Output token cap. Reasoning models (gpt-oss) spend tokens thinking
   *  before the answer — too low a cap truncates mid-reasoning and leaves
   *  `content` empty. Default 8192. */
  maxTokens?: number;
  /** Bearer token. Local servers (Ollama, llama.cpp) need none; hosted
   *  OpenAI-compatible endpoints (OpenRouter) require it. */
  apiKey?: string;
  /** Opt-in prompt caching: marks the static system prefix with an
   *  OpenRouter `cache_control` breakpoint so the repeated prefix bills as
   *  cached. The big lever on the re-sent-every-iteration cost (Epic #505,
   *  issue #511). Honored by Anthropic/Gemini/Kimi-style providers; ignored
   *  harmlessly elsewhere. Only meaningful with `apiKey` set. */
  cache?: boolean;
  /** Reasoning budget — OpenRouter's unified `reasoning` control. Only
   *  sent when the baseUrl is OpenRouter (same gating as `usage`).
   *  Without it Anthropic thinking models FREE-RUN: OpenRouter maps the
   *  model-default max_tokens into a huge thinking budget and a single
   *  ReAct iteration can burn 60k+ output tokens before its first tool
   *  call (sonnet-food session, 2026-06-10). Default `medium`.
   *
   *  Guidance: react-loop iterations want `low`/`medium` (many small
   *  calls; thinking re-derives cheaply from tool results), while
   *  one-shot draft strategies can afford `high` (a single call where
   *  deep up-front design pays for itself). `off` sends
   *  `reasoning: { enabled: false }` — explicit disable; merely
   *  omitting the field falls back to the model's default budget. */
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high';
  /** OpenRouter provider-routing sort (gated to OpenRouter exactly like
   *  `usage`/`reasoning`). Default `throughput` — OpenRouter's own
   *  default optimizes price and lands on congested providers (measured
   *  2026-06-11: 19–63 tok/s effective vs 200 tok/s throughput-sorted).
   *  `default` sends no sort field. */
  providerSort?: 'throughput' | 'price' | 'latency' | 'default';
  /** Max provider price in USD per MILLION prompt tokens — OpenRouter
   *  `provider.max_price.prompt` (docs:
   *  https://openrouter.ai/docs/guides/routing/provider-selection —
   *  `{"prompt": 1}` routes only to providers ≤ $1/M prompt tokens).
   *  Unset = no ceiling. */
  maxPromptPrice?: number;
  /** Max provider price in USD per MILLION completion tokens. */
  maxCompletionPrice?: number;
}

/** Build the OpenRouter `provider` routing preferences from opts, or
 *  `undefined` when nothing applies (sort `default` + no caps) — the
 *  field is then omitted entirely. Defaults preserve prior behavior:
 *  sort by throughput, no price ceilings. Exported for tests. */
export function buildProviderPrefs(
  opts: Pick<LocalLlmOptions, 'providerSort' | 'maxPromptPrice' | 'maxCompletionPrice'>,
): Record<string, unknown> | undefined {
  const prefs: Record<string, unknown> = {};
  const sort = opts.providerSort ?? 'throughput';
  if (sort !== 'default') prefs.sort = sort;
  const maxPrice: Record<string, number> = {};
  if (typeof opts.maxPromptPrice === 'number' && opts.maxPromptPrice > 0) {
    maxPrice.prompt = opts.maxPromptPrice;
  }
  if (typeof opts.maxCompletionPrice === 'number' && opts.maxCompletionPrice > 0) {
    maxPrice.completion = opts.maxCompletionPrice;
  }
  if (Object.keys(maxPrice).length > 0) prefs.max_price = maxPrice;
  return Object.keys(prefs).length > 0 ? prefs : undefined;
}

export function localOpenAiLlm(opts: LocalLlmOptions): ModelClient {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const isOpenRouter = /openrouter/i.test(opts.baseUrl);
  // Provider routing — sort (default throughput, see LocalLlmOptions)
  // plus optional price ceilings ($/M tokens). `undefined` = nothing
  // configured → the field is omitted from the body entirely.
  const providerPrefs = buildProviderPrefs(opts);
  // callId -> thought_signature seen on responses. Re-attached on echo even
  // if the agent runtime drops the signature from its history records.
  const thoughtSignatures = new Map<string, string>();
  // callId -> reasoning_details of the assistant turn that emitted the
  // call (Anthropic via OpenRouter). The sibling of thoughtSignatures:
  // the agent runtime's history records have no slot for message-level
  // reasoning blocks, so the client itself remembers and re-attaches.
  const reasoningDetails = new Map<string, ReasoningDetail[]>();
  return {
    id: `local:${opts.model}`,
    supportsTools: true,
    async *chat(req: { messages: NormMsg[]; tools: { name: string; description: string; parameters: unknown }[] }, signal: AbortSignal) {
      const oaiMessages = toOai(req.messages, thoughtSignatures, reasoningDetails);
      // Prompt caching (#511): put a cache_control breakpoint on the static
      // system prefix so the ~10k-token system prompt re-sent every iteration
      // bills as cached. Convert the first system message to block form.
      if (opts.cache && opts.apiKey && oaiMessages[0]?.role === 'system' && typeof oaiMessages[0].content === 'string') {
        oaiMessages[0] = {
          role: 'system',
          content: [{ type: 'text', text: oaiMessages[0].content, cache_control: { type: 'ephemeral' } }],
        };
      }
      const body: Record<string, unknown> = {
        model: opts.model,
        messages: oaiMessages,
        stream: false,
        // Ask OpenRouter for real `usage.cost` (USD) — ONLY for keyed/hosted
        // endpoints. Some local servers (Ollama) mishandle this param and
        // return near-empty output, so gate it on apiKey. Local is free
        // anyway → no cost field needed.
        // …and ONLY for OpenRouter: other OpenAI-compat hosts (Gemini's
        // /v1beta/openai layer) reject unknown top-level fields with a 400.
        ...(opts.apiKey && isOpenRouter ? { usage: { include: true } } : {}),
        // Reasoning budget — gated to OpenRouter exactly like `usage`
        // (other OpenAI-compat hosts 400 on unknown fields). The effort
        // ratio is applied to max_tokens (Anthropic: budget ≈ ratio ×
        // max_tokens, floor 1024), so the explicit max_tokens below is
        // load-bearing: without it OpenRouter uses the model-default cap
        // and `medium` can still mean a 30k+ token thinking budget.
        ...(isOpenRouter
          ? (opts.reasoningEffort ?? 'medium') === 'off'
            ? { reasoning: { enabled: false } }
            : { reasoning: { effort: opts.reasoningEffort ?? 'medium' } }
          : {}),
        // Provider routing — gated to OpenRouter like `usage` and
        // `reasoning` (other OpenAI-compat hosts 400 on unknown
        // fields). Default: sort by THROUGHPUT, not price — measured
        // 2026-06-11: default routing gave 19–63 tok/s effective across
        // a matrix; throughput-sorted Kimi K2.6 did 200 tok/s. Optional
        // price ceilings (USD per million tokens) exclude providers
        // above the cap.
        ...(isOpenRouter && providerPrefs ? { provider: providerPrefs } : {}),
        max_tokens: opts.maxTokens ?? 8192,
        ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
        ...(req.tools.length > 0
          ? {
              tools: req.tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
              tool_choice: 'auto',
            }
          : {}),
      };

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (opts.apiKey) {
        headers.Authorization = `Bearer ${opts.apiKey}`;
        // OpenRouter attribution headers — harmless against other servers.
        headers['HTTP-Referer'] = 'https://pyric-playground.web.app';
        headers['X-Title'] = 'Pyric Headless App-Build';
      }
      // Transient provider errors (rate limits, preview-tier capacity
      // spikes) get a bounded exponential backoff before failing the run:
      // 11/21 gemini-w0-baseline DV runs died on bare 503s, contaminating
      // a whole arm's grid with infra noise (conductor log 2026-06-10).
      const RETRYABLE = new Set([429, 500, 502, 503, 529]);
      const MAX_ATTEMPTS = 4;
      let resp: Response | null = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          resp = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal,
          });
        } catch (e) {
          if (signal.aborted) return;
          yield { kind: 'error', message: `local LLM fetch failed: ${e instanceof Error ? e.message : String(e)}` };
          return;
        }
        if (resp.ok || !RETRYABLE.has(resp.status) || attempt === MAX_ATTEMPTS) break;
        await resp.text().catch(() => undefined); // drain before retry
        const delay = 2000 * 2 ** (attempt - 1) * (0.5 + Math.random());
        await new Promise((r) => setTimeout(r, delay));
        if (signal.aborted) return;
      }
      if (!resp) return;
      // Feature-detect `reasoning`: a host/model that rejects the
      // parameter (4xx whose body names it) gets ONE retry without the
      // field instead of failing the run — mirrors how `usage` gating
      // keeps non-OpenRouter hosts working.
      if (!resp.ok && resp.status >= 400 && resp.status < 500 && 'reasoning' in body) {
        const errText = await resp.text().catch(() => '');
        if (/reasoning/i.test(errText)) {
          delete body.reasoning;
          try {
            resp = await fetch(`${base}/chat/completions`, {
              method: 'POST',
              headers,
              body: JSON.stringify(body),
              signal,
            });
          } catch (e) {
            if (signal.aborted) return;
            yield { kind: 'error', message: `local LLM fetch failed: ${e instanceof Error ? e.message : String(e)}` };
            return;
          }
        } else {
          yield { kind: 'error', message: `local LLM ${resp.status}: ${errText.slice(0, 240)}` };
          return;
        }
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => resp.statusText);
        yield { kind: 'error', message: `local LLM ${resp.status}: ${text.slice(0, 240)}` };
        return;
      }

      // A 200 with a non-JSON body (transient proxy/rate-limit page) must
      // NOT crash the caller — yield an error so the run records a failure
      // for this turn and continues.
      let json: {
        choices?: { message?: { content?: string; reasoning?: string; reasoning_content?: string; reasoning_details?: ReasoningDetail[]; tool_calls?: { id?: string; function?: { name?: string; arguments?: string }; extra_content?: { google?: { thought_signature?: string } } }[] } }[];
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          cost?: number;
          // cached-token reporting varies: OpenAI/Kimi style vs Anthropic style.
          prompt_tokens_details?: { cached_tokens?: number };
          cache_read_input_tokens?: number;
          completion_tokens_details?: { reasoning_tokens?: number };
        };
      };
      try {
        json = await resp.json();
      } catch (e) {
        yield { kind: 'error', message: `local LLM: non-JSON response: ${e instanceof Error ? e.message : String(e)}` };
        return;
      }
      const msg = json.choices?.[0]?.message;
      // Reasoning models surface chain-of-thought in `reasoning`
      // (OpenRouter) or `reasoning_content` (gpt-oss/llama.cpp); the
      // answer is in `content`.
      const thinking = msg?.reasoning ?? msg?.reasoning_content;
      if (thinking) yield { kind: 'thinking', text: thinking };
      if (msg?.content) yield { kind: 'text', text: msg.content };
      // Anthropic via OpenRouter: remember this turn's signed thinking
      // blocks under every tool callId it emitted, so toOai can re-attach
      // them when the calls are echoed back next iteration.
      const details = msg?.reasoning_details;
      if (details && details.length > 0) {
        for (const tc of msg?.tool_calls ?? []) {
          if (tc.id) reasoningDetails.set(tc.id, details);
        }
      }
      let i = 0;
      for (const tc of msg?.tool_calls ?? []) {
        let args: unknown = {};
        try {
          args = JSON.parse(tc.function?.arguments ?? '{}');
        } catch {
          args = { _raw: tc.function?.arguments };
        }
        const callId = tc.id ?? `local_${i}`;
        const sig = tc.extra_content?.google?.thought_signature;
        if (sig) thoughtSignatures.set(callId, sig);
        yield {
          kind: 'tool_call',
          id: callId,
          name: tc.function?.name ?? '',
          args,
          ...(sig ? { signature: sig } : {}),
        };
        i += 1;
      }
      const u = json.usage ?? {};
      const cachedTokens = u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens;
      const reasoningTokens = u.completion_tokens_details?.reasoning_tokens;
      // ModelEvent ends the turn with a `usage` event (no `turn_complete`,
      // no `details`); usage is a `ModelUsage` (outputTokens, not
      // completionTokens).
      yield {
        kind: 'usage',
        usage: {
          promptTokens: u.prompt_tokens ?? 0,
          outputTokens: u.completion_tokens ?? 0,
          ...(typeof cachedTokens === 'number' ? { cachedTokens } : {}),
          ...(typeof reasoningTokens === 'number' ? { reasoningTokens } : {}),
          ...(typeof u.cost === 'number' ? { costUsd: u.cost } : {}),
        },
      };
    },
  } as unknown as ModelClient;
}
