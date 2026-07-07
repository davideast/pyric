/**
 * Claude lane page-direct transport — the OpenAI-compatible SSE client
 * for the dev-only `/api/claude-lane/v1/chat/completions` route.
 *
 * Shape-wise this is the relay's Ollama provider (same OAI SSE wire),
 * with three lane-specific differences that justify a local copy
 * rather than reusing `@inbrowser/relay/providers/ollama`:
 *
 *   1. `reasoning_content` deltas → `thinking` events (Opus/Fable
 *      thinking runs long; without this the UI sits silent for
 *      minutes). The Ollama provider drops them.
 *   2. The terminal chunk's `usage.cost` (real USD from `claude -p`)
 *      → `costUsd`, and `usage.prompt_tokens_details.cached_tokens`
 *      → `cachedTokens`. The Ollama provider reports tokens only.
 *   3. Same-origin endpoint — no baseUrl-via-apiKey convention.
 *      `apiKey` is ignored entirely (subscription auth happens in the
 *      CLI on the server side).
 *
 * Tools are forwarded, NOT silently dropped — the route answers with a
 * structured `tools_unsupported` error that explains the lane is
 * text-only, and that error surfaces verbatim in the chat UI.
 */
import { readSseDataLines } from '@inbrowser/relay';
import type { NormalizedRequest } from '@inbrowser/relay';
import type { InferenceEvent } from './openrouter-page';

export const CLAUDE_LANE_PATH = '/api/claude-lane/v1/chat/completions';

interface OaiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
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

interface OaiStreamChunk {
  choices?: {
    delta?: { content?: string; reasoning_content?: string };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    cost?: number;
  };
  error?: { message?: string; code?: string };
}

export const claudeLaneProvider = async function* (
  req: NormalizedRequest,
): AsyncIterable<InferenceEvent> {
  const body = {
    model: req.model,
    messages: toOaiMessages(req.messages),
    stream: true as const,
    // Forwarded on purpose so the route can reject with its structured
    // text-only error — never silently dropped.
    ...(req.tools.length > 0
      ? {
          tools: req.tools.map((t) => ({
            type: 'function',
            function: {
              name: t.function.name,
              description: t.function.description,
              parameters: t.function.parameters,
            },
          })),
        }
      : {}),
    ...(req.reasoningEffort && req.reasoningEffort !== 'off'
      ? { reasoning_effort: req.reasoningEffort }
      : {}),
  };

  let response: Response;
  try {
    response = await fetch(CLAUDE_LANE_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(req.signal ? { signal: req.signal } : {}),
    });
  } catch (e) {
    if (req.signal?.aborted) return;
    yield {
      kind: 'error',
      message: `Claude lane fetch failed (${e instanceof Error ? e.message : String(e)}). Is the dev server running?`,
    };
    return;
  }

  if (!response.ok) {
    // The route returns OpenAI-shaped errors; surface `error.message`
    // verbatim (it carries the text-only / link-script guidance).
    let message = `Claude lane ${response.status}`;
    try {
      const parsed = (await response.json()) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // keep the status-only message
    }
    yield { kind: 'error', message };
    return;
  }

  let usage: InferenceEvent | null = null;
  try {
    for await (const payload of readSseDataLines(response.body)) {
      if (payload === '[DONE]') break;
      if (req.signal?.aborted) return;
      let chunk: OaiStreamChunk;
      try {
        chunk = JSON.parse(payload) as OaiStreamChunk;
      } catch {
        continue;
      }
      if (chunk.error) {
        yield { kind: 'error', message: chunk.error.message ?? 'Claude lane provider error.' };
        return;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.reasoning_content) {
        yield { kind: 'thinking', chunk: delta.reasoning_content };
      }
      if (delta?.content) {
        yield { kind: 'text', chunk: delta.content };
      }
      if (chunk.usage) {
        usage = {
          kind: 'usage',
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          ...(typeof chunk.usage.prompt_tokens_details?.cached_tokens === 'number'
            ? { cachedTokens: chunk.usage.prompt_tokens_details.cached_tokens }
            : {}),
          ...(typeof chunk.usage.cost === 'number' ? { costUsd: chunk.usage.cost } : {}),
        };
      }
    }
  } catch (e) {
    if (req.signal?.aborted) return;
    yield { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    return;
  }

  // Usage is emitted terminally (after the stream closes) to mirror the
  // other providers' event ordering.
  if (usage) yield usage;
};
