/**
 * Agentic Claude-lane `ModelClient` — the Agent SDK configured as the
 * DELEGATED AGENT the lane's system prompt promises, with the
 * playground's MCP workspace bridge mounted IN-PROCESS.
 *
 * WHY THIS EXISTS (user-found failure, trace t-mr41zqyr-npy0):
 * `@inbrowser/model`'s `claudeCodeModelClient` is deliberately a
 * BARE-MODEL provider — it pins `mcpServers: {}` + `tools: []` so the
 * SDK answers like a plain Messages call. The lane's system prompt,
 * however, tells the model it has the playground workspace mounted
 * over MCP. A model with NO tools narrates a fully fabricated build.
 *
 * Three successive zero-tools failures shaped this file, all with the
 * SAME symptom (model fabricates tool activity as text):
 *   1. bare-model provider (`mcpServers: {}`);
 *   2. HTTP bridge mounted but `tools: []` also removed the built-in
 *      tool-search tool, and MCP tools default to deferred-behind-
 *      tool-search — server never contacted;
 *   3. `alwaysLoad` fix worked in `astro dev` but the prod preview's
 *      `request.url` origin is `http://localhost` (no port) under the
 *      node adapter — the CLI connected to :80, failed, and the SDK
 *      CONTINUED SILENTLY with zero tools.
 *
 * Hence the two structural defenses here:
 *   - The MCP server is passed as an IN-PROCESS instance
 *     (`type: 'sdk'`) — no URL, no port, no transport to mis-derive.
 *     The instance is the same `buildWorkspaceMcpServer` the HTTP
 *     route uses; the Agent SDK only ever calls `.connect(transport)`
 *     on it, which the low-level `Server` provides.
 *   - The turn HARD-ABORTS unless the SDK's `init` message reports the
 *     playground server `connected` with every expected tool. A missing
 *     mount becomes a one-line visible error, never a fabricated build.
 *
 * Built-in Claude Code tools stay OFF (no host Read/Write/Bash — the
 * workspace jail is exactly the MCP surface). Streaming mirrors
 * `claudeCodeModelClient` (text/thinking deltas, terminal usage,
 * subscription auth with `ANTHROPIC_API_KEY` stripped), plus tool_use
 * blocks surface as `thinking` events (`→ name({...})`) so the
 * drill-in shows REAL tool activity.
 */
import type { ModelClient, ModelEvent, ModelRequest } from '@inbrowser/model';
import { renderPrompt } from '@inbrowser/model';
import {
  buildWorkspaceMcpServer,
  loadWorkspaceTools,
  MCP_SERVER_NAME,
  mcpAllowedTools,
} from './claude-mcp';

interface AgenticConfig {
  model: string;
}

function toEffort(effort: unknown): 'low' | 'medium' | 'high' | undefined {
  return effort === 'low' || effort === 'medium' || effort === 'high' ? effort : undefined;
}

/** One-line summary of a tool_use block for the thinking stream. */
function toolUseLine(name: string, input: unknown): string {
  let args = '';
  try {
    args = JSON.stringify(input);
  } catch {
    args = '…';
  }
  if (args.length > 160) args = `${args.slice(0, 160)}…`;
  const short = name.replace(`mcp__${MCP_SERVER_NAME}__`, '');
  return `\n→ ${short}(${args})\n`;
}

interface InitMessage {
  type?: string;
  subtype?: string;
  mcp_servers?: Array<{ name?: string; status?: string; error?: string }>;
  tools?: string[];
}

/**
 * The mount invariant: playground server connected, every expected
 * tool present in the session's tool list. Returns null when
 * satisfied, else a human-readable violation.
 */
export function mcpMountViolation(init: InitMessage): string | null {
  const server = init.mcp_servers?.find((s) => s.name === MCP_SERVER_NAME);
  if (!server) return `MCP server '${MCP_SERVER_NAME}' missing from session init.`;
  if (server.status !== 'connected') {
    return `MCP server '${MCP_SERVER_NAME}' status '${server.status}'${
      server.error ? ` (${server.error})` : ''
    }.`;
  }
  const have = new Set(init.tools ?? []);
  const missing = mcpAllowedTools().filter((t) => !have.has(t));
  if (missing.length > 0) {
    return `workspace tools missing from session: ${missing.join(', ')}.`;
  }
  return null;
}

export function claudeAgenticModelClient(config: AgenticConfig): ModelClient {
  return {
    id: `claude-agentic:${config.model}`,
    supportsTools: false, // caller-defined tools unsupported; MCP tools are the surface
    async *chat(req: ModelRequest, signal?: AbortSignal): AsyncGenerator<ModelEvent> {
      if (signal?.aborted) return;
      const { system, prompt } = renderPrompt(req.messages);
      if (!prompt) {
        yield { kind: 'error', message: 'claude-agentic: no user message to send.' };
        return;
      }

      let query: typeof import('@anthropic-ai/claude-agent-sdk').query;
      try {
        // Runtime import — Node-only SDK, never bundled client-side.
        const specifier = '@anthropic-ai/claude-agent-sdk';
        ({ query } = (await import(/* @vite-ignore */ specifier)) as {
          query: typeof import('@anthropic-ai/claude-agent-sdk').query;
        });
      } catch (e) {
        yield {
          kind: 'error',
          message: `claude-agentic: failed to load @anthropic-ai/claude-agent-sdk: ${
            e instanceof Error ? e.message : String(e)
          }`,
        };
        return;
      }

      // In-process workspace bridge: same handlers + server the HTTP
      // route uses, fresh instance per turn (a Server connects to one
      // transport), no network hop.
      const mcpInstance = buildWorkspaceMcpServer(await loadWorkspaceTools());

      // Subscription-only auth: strip ANTHROPIC_API_KEY so the host's
      // Claude Code login always wins (same posture as the bare provider).
      const env: Record<string, string | undefined> = { ...process.env };
      delete env.ANTHROPIC_API_KEY;

      const abortController = new AbortController();
      const onAbort = () => abortController.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const effort = toEffort(req.reasoningEffort);

      let promptTokens = 0;
      let outputTokens = 0;
      let cachedTokens: number | undefined;
      let sawText = false;
      let sawResult = false;
      let mountVerified = false;
      let fallbackText = '';

      try {
        for await (const msg of query({
          prompt,
          options: {
            ...(config.model ? { model: config.model } : {}),
            systemPrompt: system,
            // Built-in Claude Code tools OFF — the jail is the MCP surface.
            tools: [],
            settingSources: [],
            mcpServers: {
              [MCP_SERVER_NAME]: {
                type: 'sdk' as const,
                name: MCP_SERVER_NAME,
                // Low-level `Server` — the SDK only calls `.connect()`,
                // shared by both classes. See module docblock.
                instance: mcpInstance as unknown as import('@anthropic-ai/claude-agent-sdk').McpSdkServerConfigWithInstance['instance'],
              },
            },
            strictMcpConfig: true,
            allowedTools: mcpAllowedTools(),
            permissionMode: 'bypassPermissions' as const,
            includePartialMessages: true,
            ...(effort ? { effort } : {}),
            abortController,
            env,
          },
        })) {
          if (signal?.aborted) return;
          const m = msg as InitMessage & {
            event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
            message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> };
            is_error?: boolean;
            result?: unknown;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
          };
          if (m.type === 'system' && m.subtype === 'init') {
            // THE INVARIANT: no tools mounted → no turn. A silent
            // zero-tools session is how every fabricated build started.
            const violation = mcpMountViolation(m);
            if (violation) {
              abortController.abort();
              yield {
                kind: 'error',
                message:
                  `claude-agentic: workspace tools failed to mount — turn aborted. ${violation} ` +
                  'The model was NOT run without tools (it would fabricate results).',
              };
              return;
            }
            mountVerified = true;
            yield {
              kind: 'thinking',
              text: `✓ workspace mounted (${mcpAllowedTools().length} tools, in-process)\n`,
            };
            continue;
          }
          if (m.type === 'stream_event' && m.event?.type === 'content_block_delta') {
            const delta = m.event.delta;
            if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
              sawText = true;
              yield { kind: 'text', text: delta.text };
            } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
              yield { kind: 'thinking', text: delta.thinking };
            }
            continue;
          }
          if (m.type === 'assistant' && m.message?.content) {
            for (const block of m.message.content) {
              if (block.type === 'text' && typeof block.text === 'string') {
                fallbackText += block.text;
              } else if (block.type === 'tool_use' && typeof block.name === 'string') {
                // Real tool activity, surfaced in the thinking stream so
                // the drill-in shows WHAT the delegated agent actually did.
                yield { kind: 'thinking', text: toolUseLine(block.name, block.input) };
              }
            }
            continue;
          }
          if (m.type === 'result') {
            sawResult = true;
            if (m.is_error || (m.subtype && m.subtype !== 'success')) {
              yield {
                kind: 'error',
                message: `claude-agentic SDK reported ${m.subtype ?? 'error'}: ${
                  typeof m.result === 'string' && m.result ? m.result.slice(0, 400) : '(no detail)'
                }`,
              };
              return;
            }
            if (!mountVerified) {
              // Defensive: a session that never emitted init should not
              // pass its output off as a tools turn.
              yield {
                kind: 'error',
                message:
                  'claude-agentic: session ended without an init message — cannot verify the workspace mount; discarding output.',
              };
              return;
            }
            if (!sawText) {
              const text = typeof m.result === 'string' && m.result ? m.result : fallbackText;
              if (text) yield { kind: 'text', text };
            }
            promptTokens = m.usage?.input_tokens ?? promptTokens;
            outputTokens = m.usage?.output_tokens ?? outputTokens;
            if (typeof m.usage?.cache_read_input_tokens === 'number') {
              cachedTokens = m.usage.cache_read_input_tokens;
            }
            yield {
              kind: 'usage',
              usage: {
                promptTokens,
                outputTokens,
                ...(typeof cachedTokens === 'number' ? { cachedTokens } : {}),
              },
            };
            return;
          }
          // system status / compact_boundary / rate-limit / unknown — skip.
        }
      } catch (e) {
        if (signal?.aborted) return;
        yield { kind: 'error', message: e instanceof Error ? e.message : String(e) };
        return;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
      if (!sawResult) {
        yield { kind: 'error', message: 'claude-agentic: SDK stream ended without a result message.' };
      }
    },
  };
}
