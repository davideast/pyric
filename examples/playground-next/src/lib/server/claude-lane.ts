/**
 * Claude lane — dev-only OpenAI-compatible `/chat/completions` handler
 * backed by `@inbrowser/model`'s `claudeCodeModelClient` — the Claude
 * **Agent SDK** provider. It calls `query()` from
 * `@anthropic-ai/claude-agent-sdk` programmatically, authenticated
 * against the host's Claude Code login (Pro/Max subscription); there is
 * no `claude -p` subprocess and no NDJSON parsing.
 *
 * Why this shape: the playground's entire client plumbing already
 * speaks OpenAI-compatible SSE (the relay's Ollama provider, the
 * experiment harness's `localOpenAiLlm`). Exposing the Agent SDK behind
 * the same wire shape means the dropdown's Claude entries reuse that
 * plumbing — no new transport concepts, and the route is curl-able for
 * smoke tests.
 *
 * Contract:
 *
 *   POST body — OpenAI chat-completions subset:
 *     { model, messages, stream: true, reasoning_effort?, tools? }
 *   Responses:
 *     - 404 when the lane is disabled (non-dev builds — the Agent SDK
 *       spawns a Node-only subprocess and is never deployed).
 *     - 400 `tools_unsupported` when tools are present. The Agent-SDK
 *       provider runs in a bare-model configuration with no
 *       tool-registration surface (`supportsTools: false`), so it cannot
 *       honor caller-defined tools. Draft → Validate works on this lane
 *       (its model calls are tool-free); tool-calling strategies need an
 *       API-key provider.
 *     - 400 `model_not_supported` for ids outside the four-model allowlist.
 *     - 200 SSE otherwise: `chat.completion.chunk` deltas (`content`,
 *       and `reasoning_content` for thinking — the same extension field
 *       OpenRouter/DeepSeek use), a terminal chunk with
 *       `finish_reason: "stop"` and a `usage` object carrying
 *       `prompt_tokens_details.cached_tokens` as an extension field, then
 *       `data: [DONE]`. Mid-stream provider failures (including the SDK
 *       failing to load or the subscription login being unavailable)
 *       arrive as a `data: {"error":{…}}` line followed by `[DONE]` —
 *       the SDK's own error text is surfaced verbatim.
 *
 * Auth: `config.apiKey` is ignored by the provider — the host's Claude
 * Code subscription login applies (`~/.claude/.credentials.json`). No
 * API-key UI exists for this lane. Because the SDK draws from the
 * subscription, no real dollar cost is reported, so the terminal `usage`
 * carries no `cost` field (unlike the OpenRouter lane).
 */
import type { ModelClient, ModelMessage, ModelRequest } from '@inbrowser/model';

/** Factory for the Agent-SDK `ModelClient`. The route supplies the
 *  real `claudeCodeModelClient` binding; tests inject a fake client (and
 *  can capture the `ModelRequest` it was handed) so no SDK is spawned. */
export type ClaudeLaneClientFactory = (model: string) => ModelClient;

/** The four models the lane exposes. Full ids, verified against the
 *  Claude model catalog. The Agent SDK accepts aliases (`opus`/`fable`),
 *  but full names are preferred for determinism. */
export const CLAUDE_LANE_MODELS = [
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'claude-fable-5',
] as const;

export interface ClaudeLaneOptions {
  /** `import.meta.env.DEV` at the route. False ⇒ 404 — the lane never
   *  serves outside the dev server (the SDK is a Node-only subprocess). */
  enabled: boolean;
  /** Builds the Agent-SDK `ModelClient` for the requested model. The
   *  route binds `claudeCodeModelClient`; tests inject a fake. */
  createClient: ClaudeLaneClientFactory;
}

// ── OpenAI request body (subset we accept) ───────────────────────────

interface OaiContentPart {
  type?: string;
  text?: string;
}

interface OaiMessage {
  role?: string;
  content?: string | null | OaiContentPart[];
  tool_calls?: {
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
  tool_call_id?: string;
  name?: string;
}

interface OaiBody {
  model?: string;
  messages?: OaiMessage[];
  stream?: boolean;
  tools?: unknown[];
  functions?: unknown[];
  reasoning_effort?: string;
  reasoning?: { effort?: string };
}

function oaiError(status: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({
      error: { message, type: 'invalid_request_error', code },
    }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

function contentToText(content: OaiMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && (p.type === 'text' || p.type === undefined))
      .map((p) => p.text ?? '')
      .join('');
  }
  return '';
}

/** OpenAI messages → `@inbrowser/model` `ModelMessage[]`. Histories will
 *  be text-only in practice (the lane rejects tools), but assistant
 *  tool_calls / tool results are mapped anyway so transcripts recorded
 *  on other lanes replay without data loss (the provider's `renderPrompt`
 *  flattens them into its transcript prompt). */
export function toModelMessages(messages: OaiMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    const role = m.role;
    if (role === 'system' || role === 'user') {
      out.push({ role, text: contentToText(m.content) });
      continue;
    }
    if (role === 'assistant') {
      const entry: ModelMessage = {
        role: 'assistant',
        text: contentToText(m.content),
      };
      if (m.tool_calls && m.tool_calls.length > 0) {
        entry.toolCalls = m.tool_calls.map((c, i) => {
          let args: unknown = {};
          try {
            args = c.function?.arguments ? JSON.parse(c.function.arguments) : {};
          } catch {
            args = { _raw: c.function?.arguments };
          }
          return { id: c.id ?? `cl_${i}`, name: c.function?.name ?? '', args };
        });
      }
      out.push(entry);
      continue;
    }
    if (role === 'tool') {
      out.push({
        role: 'tool',
        toolCallId: m.tool_call_id ?? '',
        name: m.name ?? '',
        resultJson: contentToText(m.content),
      });
    }
    // Unknown roles dropped.
  }
  return out;
}

function toReasoningEffort(body: OaiBody): ModelRequest['reasoningEffort'] {
  const raw = body.reasoning_effort ?? body.reasoning?.effort;
  return raw === 'low' || raw === 'medium' || raw === 'high' ? raw : undefined;
}

// ── SSE assembly ─────────────────────────────────────────────────────

interface UsageAccumulator {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
  /** OpenRouter-convention extension: real dollar cost. The Agent-SDK
   *  provider draws from the subscription and reports none, so this is
   *  absent on the Claude lane. */
  cost?: number;
}

function chunkEnvelope(id: string, model: string, created: number) {
  return (delta: Record<string, unknown>, finish: string | null, usage?: UsageAccumulator) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    })}\n\n`;
}

/**
 * Handle one OpenAI-compatible chat-completions request. All
 * validation happens before the stream Response is constructed, so
 * callers get proper HTTP status codes for bad requests; only provider
 * runtime failures (SDK load failure, subscription unavailable, mid-turn
 * errors) arrive in-band as SSE error lines — surfaced from the SDK's
 * own `error` events.
 */
export async function handleClaudeLaneRequest(
  request: Request,
  opts: ClaudeLaneOptions,
): Promise<Response> {
  if (!opts.enabled) {
    return oaiError(
      404,
      'lane_disabled',
      'The Claude (Agent SDK) lane only runs on the local dev server — it calls the Claude Agent SDK as a Node subprocess and is never deployed.',
    );
  }

  let body: OaiBody;
  try {
    body = (await request.json()) as OaiBody;
  } catch {
    return oaiError(400, 'invalid_json', 'Request body must be JSON.');
  }

  const toolCount = (body.tools?.length ?? 0) + (body.functions?.length ?? 0);
  if (toolCount > 0) {
    return oaiError(
      400,
      'tools_unsupported',
      'The Claude (Agent SDK) lane runs in a bare-model configuration with no tool-registration surface, so tool-bearing requests cannot run. ' +
        'Draft → Validate works on this lane (its model calls are tool-free); ' +
        'for tool-calling strategies (ReAct) pick an API-key provider, or pin the strategy to Draft → Validate in Settings.',
    );
  }

  const model = body.model ?? '';
  if (!(CLAUDE_LANE_MODELS as readonly string[]).includes(model)) {
    return oaiError(
      400,
      'model_not_supported',
      `Unknown Claude lane model '${model}'. Supported: ${CLAUDE_LANE_MODELS.join(', ')}.`,
    );
  }

  if (body.stream !== true) {
    return oaiError(400, 'stream_required', 'The Claude lane is SSE-only — send "stream": true.');
  }

  const messages = toModelMessages(body.messages ?? []);
  if (!messages.some((m) => m.role === 'user')) {
    return oaiError(400, 'no_user_message', 'At least one user message is required.');
  }

  const client = opts.createClient(model);

  const req: ModelRequest = {
    messages,
    tools: [],
    toolUseEnabled: false,
    ...(toReasoningEffort(body) ? { reasoningEffort: toReasoningEffort(body) } : {}),
  };

  const id = `claudelane-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const created = Math.floor(Date.now() / 1000);
  const frame = chunkEnvelope(id, model, created);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => controller.enqueue(encoder.encode(s));
      try {
        let finished = false;
        for await (const evt of client.chat(req, request.signal)) {
          if (request.signal.aborted) break;
          switch (evt.kind) {
            case 'text':
              send(frame({ content: evt.text }, null));
              break;
            case 'thinking':
              send(frame({ reasoning_content: evt.text }, null));
              break;
            case 'usage': {
              // Cache-aware mapping (user-found, trace t-mq9msa9m-xcgt):
              // Anthropic's `input_tokens` EXCLUDES cache reads, so a
              // fully-cached prompt reported `tokensIn: 2` in the UI
              // against a real (subscription) cost. The OpenRouter
              // convention this wire shape follows (and the metrics
              // collector's billing math assumes) is prompt_tokens = the
              // WHOLE prompt, with cached_tokens as the detail — so fold
              // the cache reads back in. The Agent-SDK provider surfaces
              // cache reads as `usage.cachedTokens`.
              const cached =
                typeof evt.usage.cachedTokens === 'number' ? evt.usage.cachedTokens : 0;
              const promptTokens = evt.usage.promptTokens + cached;
              const usage: UsageAccumulator = {
                prompt_tokens: promptTokens,
                completion_tokens: evt.usage.outputTokens,
                total_tokens: promptTokens + evt.usage.outputTokens,
                ...(typeof evt.usage.cachedTokens === 'number'
                  ? { prompt_tokens_details: { cached_tokens: evt.usage.cachedTokens } }
                  : {}),
                ...(typeof evt.usage.costUsd === 'number' ? { cost: evt.usage.costUsd } : {}),
              };
              send(frame({}, 'stop', usage));
              finished = true;
              break;
            }
            case 'error':
              send(
                `data: ${JSON.stringify({
                  error: { message: evt.message, type: 'api_error', code: 'provider_error' },
                })}\n\n`,
              );
              finished = true;
              break;
            case 'tool_call':
              // Unreachable on this lane: text mode rejects tools up
              // front and the provider's `supportsTools` is false (the
              // request always carries `tools: []`). Mapped defensively
              // so a provider drift doesn't wedge the stream silently.
              send(
                `data: ${JSON.stringify({
                  error: {
                    message: 'claude-code lane emitted an unexpected tool_call event.',
                    type: 'api_error',
                    code: 'provider_error',
                  },
                })}\n\n`,
              );
              finished = true;
              break;
          }
          if (finished) break;
        }
        if (!finished && !request.signal.aborted) {
          // Provider ended without a terminal usage/error event.
          send(frame({}, 'stop'));
        }
        send('data: [DONE]\n\n');
      } catch (e) {
        send(
          `data: ${JSON.stringify({
            error: {
              message: e instanceof Error ? e.message : String(e),
              type: 'api_error',
              code: 'provider_error',
            },
          })}\n\n`,
        );
        send('data: [DONE]\n\n');
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
