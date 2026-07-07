/**
 * In-repo page-direct OpenAI-compatible provider — the engine behind
 * both the Ollama and llama.cpp `llama-server` lanes, emitting the
 * playground's flat `InferenceEvent` stream.
 *
 * This was `@inbrowser/relay/providers/ollama` through 0.3.x. Published
 * `@inbrowser/relay@0.4.0` moved the cloud providers into
 * `@inbrowser/model` as `ModelClient` factories (a different event
 * shape, nested usage), and `@inbrowser/model` is not a playground
 * dependency. So — as with `./openrouter-page` and `./gemini-page` —
 * the provider lives in-repo, ported to the flat page-direct contract.
 *
 * Every server that speaks the OpenAI `POST /v1/chat/completions` wire
 * shape — Ollama, llama.cpp's `llama-server`, vLLM, LM Studio, … —
 * streams the same SSE deltas and reports the same `usage` fields, so
 * one implementation serves both the `ollama` and `llamaServer`
 * providers. The server base URL rides in `req.apiKey` (the
 * playground's BYOK slot for local servers is a base URL, not a
 * secret); no `Authorization` header is sent (Ollama doesn't
 * authenticate).
 */
import { readSseDataLines } from '@inbrowser/relay';
import type { NormalizedRequest } from '@inbrowser/relay';
import type { InferenceEvent } from './openrouter-page';
import { assertSafeServerBaseUrl, SsrfBlockedError, type HostResolver } from './ollama-ssrf';

const DEFAULT_BASE_URL = 'http://localhost:11434';

/** True when this module is evaluating OUTSIDE a browser (Cloud
 *  Function / Astro SSR). The base URL is only an SSRF risk there — in
 *  the browser it points at the end-user's own machine. */
const IS_SERVER = typeof window === 'undefined';

/** Node `dns.lookup`-backed resolver, imported lazily so the browser
 *  bundle never statically references `node:dns`. Returns all resolved
 *  addresses for a hostname so the SSRF guard can reject a name that
 *  points at an internal IP. */
async function nodeHostResolver(hostname: string): Promise<string[]> {
  const { lookup } = await import('node:dns/promises');
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
}

interface OaiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OaiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: OaiToolCall[];
  tool_call_id?: string;
  name?: string;
}

function toOaiMessages(messages: NormalizedRequest['messages']): OaiMessage[] {
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
          type: 'function',
          function: {
            name: c.name,
            arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}),
          },
        }));
        if (!msg.content) msg.content = null;
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

function toOaiTools(tools: NormalizedRequest['tools']): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
  emitted: boolean;
}

/** Trim trailing slashes off a base URL, falling back when the value is
 *  empty or not an http(s) URL. */
function resolveBaseUrl(raw: string | undefined, fallback: string): string {
  return raw && /^https?:\/\//.test(raw) ? raw.replace(/\/+$/, '') : fallback;
}

/**
 * Page-direct Ollama / OpenAI-compatible provider. The server base URL
 * comes from `req.apiKey`; per-call values (messages, tools, sampling)
 * from the `NormalizedRequest`.
 */
export const ollamaProvider = async function* (
  req: NormalizedRequest,
): AsyncIterable<InferenceEvent> {
  const signal = req.signal;
  const base = resolveBaseUrl(req.apiKey, DEFAULT_BASE_URL);
  const endpoint = `${base}/v1/chat/completions`;

  // Defense-in-depth (#766): if this page-direct provider is ever
  // reached in a SERVER runtime, the base URL is attacker-controlled and
  // becomes an SSRF primitive. Reject internal targets (loopback /
  // link-local / RFC1918 / metadata) before we fetch. In the browser the
  // base URL is the end-user's own machine, so we skip the guard there.
  if (IS_SERVER) {
    const resolver: HostResolver = nodeHostResolver;
    try {
      await assertSafeServerBaseUrl(base, resolver);
    } catch (e) {
      if (e instanceof SsrfBlockedError) {
        yield { kind: 'error', message: 'ollama: base URL not permitted' };
        return;
      }
      yield { kind: 'error', message: 'ollama: base URL validation failed' };
      return;
    }
  }
  const body = {
    model: req.model,
    messages: toOaiMessages(req.messages),
    stream: true,
    ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
    ...(typeof req.topP === 'number' ? { top_p: req.topP } : {}),
    ...(typeof req.topK === 'number' ? { top_k: req.topK } : {}),
    ...(req.tools.length > 0
      ? { tools: toOaiTools(req.tools), tool_choice: 'auto' as const }
      : {}),
  };

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // Block redirect-based SSRF bypass — a benign-looking public base
      // URL must not 30x the server onto an internal host.
      redirect: 'error',
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    if (signal?.aborted) return;
    const msg = e instanceof Error ? e.message : String(e);
    yield {
      kind: 'error',
      message:
        `Ollama fetch failed (${msg}). Confirm \`ollama serve\` is running at ${base} ` +
        `and that OLLAMA_ORIGINS permits this origin.`,
    };
    return;
  }

  if (!response.ok) {
    // In the browser the upstream is the user's own server, so echoing a
    // snippet of its error body is helpful debugging. Server-side the
    // upstream is attacker-chosen — never reflect its bytes back (they
    // could exfiltrate an internal endpoint's response), just the status.
    if (IS_SERVER) {
      yield { kind: 'error', message: `Ollama upstream error (${response.status})` };
      return;
    }
    const text = await response.text().catch(() => response.statusText);
    yield { kind: 'error', message: `Ollama ${response.status}: ${text.slice(0, 240)}` };
    return;
  }

  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens: number | undefined;
  const pending = new Map<number, PendingToolCall>();

  try {
    for await (const payload of readSseDataLines(response.body)) {
      if (payload === '[DONE]') break;
      if (signal?.aborted) return;
      let evt: unknown;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }
      const e = evt as {
        choices?: {
          delta?: {
            content?: string;
            reasoning?: string;
            reasoning_content?: string;
            tool_calls?: {
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }[];
          };
        }[];
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
      };
      const delta = e.choices?.[0]?.delta;
      const reasoning = delta?.reasoning ?? delta?.reasoning_content;
      if (reasoning) {
        yield { kind: 'thinking', chunk: reasoning };
      }
      if (delta?.content) {
        yield { kind: 'text', chunk: delta.content };
      }
      if (delta?.tool_calls) {
        for (const d of delta.tool_calls) {
          let pc = pending.get(d.index);
          if (!pc) {
            pc = { id: d.id ?? '', name: '', args: '', emitted: false };
            pending.set(d.index, pc);
          }
          if (d.id) pc.id = d.id;
          if (d.function?.name) pc.name = d.function.name;
          if (d.function?.arguments) pc.args += d.function.arguments;
        }
      }
      if (e.usage) {
        promptTokens = e.usage.prompt_tokens ?? promptTokens;
        completionTokens = e.usage.completion_tokens ?? completionTokens;
        if (typeof e.usage.prompt_tokens_details?.cached_tokens === 'number') {
          cachedTokens = e.usage.prompt_tokens_details.cached_tokens;
        }
      }
    }
  } catch (e) {
    if (signal?.aborted) return;
    yield { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    return;
  }

  // Tool calls stream argument-by-argument; emit once after the stream
  // closes so we don't fire on half-parsed JSON.
  for (const pc of pending.values()) {
    if (pc.emitted) continue;
    let parsedArgs: unknown = {};
    try {
      parsedArgs = pc.args ? JSON.parse(pc.args) : {};
    } catch {
      parsedArgs = { _raw: pc.args };
    }
    yield {
      kind: 'tool_call',
      callId: pc.id || `oll_${Math.random().toString(36).slice(2, 10)}`,
      name: pc.name,
      args: parsedArgs,
    };
    pc.emitted = true;
  }

  yield {
    kind: 'usage',
    promptTokens,
    outputTokens: completionTokens,
    ...(typeof cachedTokens === 'number' ? { cachedTokens } : {}),
  };
};
