/**
 * MCP server assembly. Constructs an `@modelcontextprotocol/sdk`
 * `McpServer` whose tools dispatch into the supplied bridge for
 * forwarded calls (sandbox mode) plus optional in-process handlers
 * (rules tooling, prod control plane).
 *
 * Each tool's MCP handler returns the bridge's `BridgeToolResult`
 * serialised as a single MCP text content block — a stable shape so
 * skill prompts work without adjustment.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolHandler } from '@inbrowser/agent';
import type { Bridge, BridgeToolResult } from './bridge.js';
import type { ToolMetadata } from './tool-metadata.js';
import { jsonSchemaToZodShape } from './json-schema-to-zod.js';
import { policyFor } from './confirm-policy.js';

export interface RegisterToolsOptions {
  /** Metadata for tools whose dispatch goes to the bridge peer. */
  forwarded: ToolMetadata[];
  /** Live handlers for tools that execute in-process on the bridge. */
  inProcess: ToolHandler[];
  /**
   * Policy map consulted by the prod-mode confirmation gate. Only
   * read when `bridge.confirmHandler` is non-null AND `bridge.mode`
   * is 'prod'. Sandbox-mode bridges skip the gate entirely.
   */
  policies?: ReadonlyMap<string, import('./confirm-policy.js').ConfirmPolicy>;
}

function toMcpResult(result: BridgeToolResult, mode: string, project: string) {
  // Wrap the bridge's tool result in MCP's content envelope. Include
  // the mode + project in a metadata block so the calling agent
  // (and the human reading the transcript) can always tell which
  // target the tool hit.
  const body = {
    ...result,
    _pyric: { mode, project },
  };
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(body, null, 2),
      },
    ],
    isError: !result.ok,
  };
}

/**
 * Build an MCP server seeded with the supplied tool surface. Caller
 * connects the returned server to a transport (e.g.
 * StreamableHTTPServerTransport).
 */
export function buildMcpServer(
  bridge: Bridge,
  options: RegisterToolsOptions,
): McpServer {
  const server = new McpServer({
    name: 'pyric',
    version: bridge.version,
  });

  // Forwarded tools: bridge.dispatch handles the wire round-trip.
  for (const meta of options.forwarded) {
    const shape = jsonSchemaToZodShape(meta.parameters as never);
    // The MCP SDK's `tool()` overloads have a deep generic tree
    // that trips `Type instantiation is excessively deep` at the call
    // site for the variadic shape argument. The cast collapses the
    // inference; the runtime contract is the same.
    (server.tool as unknown as Function)(
      meta.name,
      meta.description,
      shape,
      async (args: Record<string, unknown>) => {
        const result = await bridge.dispatch(meta.name, args ?? {});
        return toMcpResult(result, bridge.mode, bridge.project);
      },
    );
  }

  // In-process tools: execute their own logic here in Node.
  // In prod mode, gate execution behind the bridge's confirm handler
  // (per design rationale). Sandbox mode runs
  // them straight through — these are the rules/lint/audit tools
  // that don't touch real Firebase.
  const gateProdTool = bridge.mode === 'prod' && bridge.confirmHandler !== null;
  const policies = options.policies;

  for (const handler of options.inProcess) {
    const shape = jsonSchemaToZodShape(handler.parameters as never);
    (server.tool as unknown as Function)(
      handler.name,
      handler.description,
      shape,
      async (args: Record<string, unknown>) => {
        const startedAtMs = Date.now();
        let confirmationBlock:
          | NonNullable<import('./bridge.js').BridgeToolEvent['confirmation']>
          | undefined;

        if (gateProdTool && bridge.confirmHandler) {
          const policy = policies
            ? policyFor(policies, handler.name, 'always')
            : 'always';
          if (policy === 'never') {
            // Skip the call entirely — handler runs straight through.
            confirmationBlock = {
              policy,
              decision: 'approved',
              reason: 'policy-never',
              elapsed_ms: 0,
            };
          } else {
            const decision = await bridge.confirmHandler.ask({
              tool: handler.name,
              args: args ?? {},
              mode: 'prod',
              project: bridge.project,
            });
            confirmationBlock = {
              policy,
              decision: decision.approved ? 'approved' : 'denied',
              reason: decision.reason,
              elapsed_ms: decision.elapsedMs,
              prompt_shown_at: decision.promptShownAt?.toISOString(),
            };
            if (!decision.approved) {
              const result = {
                ok: false,
                summary: `tool call denied — ${decision.reason}`,
              };
              bridge.recordToolEvent({
                timestamp: new Date(startedAtMs).toISOString(),
                mode: bridge.mode,
                project: bridge.project,
                tool: handler.name,
                args: args ?? {},
                result,
                durationMs: Date.now() - startedAtMs,
                confirmation: confirmationBlock,
              });
              return toMcpResult(result, bridge.mode, bridge.project);
            }
          }
        }

        try {
          // The bridge supplies an AbortSignal-less ToolContext; tools
          // that genuinely need cancellation should still respect a
          // signal supplied via the MCP transport in the future.
          const ctx = {
            signal: new AbortController().signal,
          } as never;
          const result = await handler.execute(args ?? {}, ctx);
          const normalised = {
            ok: result.ok,
            summary: result.summary,
            data: result.data,
          };
          bridge.recordToolEvent({
            timestamp: new Date(startedAtMs).toISOString(),
            mode: bridge.mode,
            project: bridge.project,
            tool: handler.name,
            args: args ?? {},
            result: normalised,
            durationMs: Date.now() - startedAtMs,
            confirmation: confirmationBlock,
          });
          return toMcpResult(normalised, bridge.mode, bridge.project);
        } catch (err) {
          const result = {
            ok: false,
            summary: err instanceof Error ? err.message : String(err),
          };
          bridge.recordToolEvent({
            timestamp: new Date(startedAtMs).toISOString(),
            mode: bridge.mode,
            project: bridge.project,
            tool: handler.name,
            args: args ?? {},
            result,
            durationMs: Date.now() - startedAtMs,
            confirmation: confirmationBlock,
          });
          return toMcpResult(result, bridge.mode, bridge.project);
        }
      },
    );
  }

  return server;
}
