/**
 * MCP server assembly. Constructs an `@modelcontextprotocol/sdk`
 * `McpServer` whose tools dispatch into the supplied bridge for
 * forwarded calls plus in-process sandbox verification handlers.
 *
 * Each tool's MCP handler returns the bridge's `BridgeToolResult`
 * serialised as a single MCP text content block — a stable shape so
 * skill prompts work without adjustment.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolHandler } from '@inbrowser/agent';
import type { Bridge, BridgeToolResult } from './bridge.js';
import type { ToolMetadata } from './tool-metadata.js';
import { jsonSchemaToZodShape } from './json-schema-to-zod.js';

export interface RegisterToolsOptions {
  /** Metadata for tools whose dispatch goes to the bridge peer. */
  forwarded: ToolMetadata[];
  /** Live handlers for tools that execute in-process on the bridge. */
  inProcess: ToolHandler[];
  /**
   * Called for a `tools/call` the MCP SDK refuses before any handler runs, so
   * the call is still observable. Every other call is recorded by the handler
   * that ran it, through `bridge.dispatch` or `bridge.recordToolEvent`. When
   * this is absent the server behaves exactly as it did without the seam.
   */
  onCallRejected?: (rejection: RejectedToolCall) => void;
}

/** A `tools/call` the SDK refused before dispatch. */
export interface RejectedToolCall {
  /** The tool name as the client sent it. */
  tool: string;
  args: Record<string, unknown>;
  /** The SDK's error text, returned to the client as an error result. */
  message: string;
  durationMs: number;
  /** True when the refusal was argument schema validation, not an unknown tool. */
  schemaRejected: boolean;
}

/**
 * Text the SDK puts in front of an argument validation failure. It is not at
 * the start of the returned message: the SDK raises an `McpError`, whose own
 * message prefixes the JSON-RPC code, and returns that text to the client.
 */
const INPUT_VALIDATION_MARKER = 'Input validation error:';

function isArgumentValidationFailure(message: string): boolean {
  return message.includes(INPUT_VALIDATION_MARKER);
}

/** First text block of an MCP result, which is where the SDK puts its error. */
function resultErrorText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const first = content?.[0];
  if (first?.type === 'text' && typeof first.text === 'string') return first.text;
  return '';
}

type CallToolInvocation = (request: unknown, extra: object) => Promise<unknown>;

/**
 * Observe `tools/call` requests the SDK answers without running a handler.
 *
 * The SDK validates arguments against the tool's schema inside its own
 * `tools/call` request handler and turns a failure into an error result before
 * the tool handler is reached, so a rejected call is invisible to the handlers
 * below. Wrapping the request handler at registration time is the one place
 * that sees it. Returns the set the tool handlers mark to say they ran; a
 * finished request whose `extra` is not in the set never reached a handler.
 */
export function observeRejectedCalls(
  server: McpServer,
  onRejected: (rejection: RejectedToolCall) => void,
): WeakSet<object> {
  const handlerRan = new WeakSet<object>();
  const inner = server.server as unknown as {
    setRequestHandler: (schema: unknown, handler: CallToolInvocation) => void;
  };
  const registerHandler = inner.setRequestHandler.bind(inner);
  inner.setRequestHandler = (schema: unknown, handler: CallToolInvocation): void => {
    if (schema !== CallToolRequestSchema) {
      registerHandler(schema, handler);
      return;
    }
    registerHandler(schema, async (request: unknown, extra: object) => {
      const startedAtMs = Date.now();
      const result = await handler(request, extra);
      if (handlerRan.has(extra)) return result;
      const params = (request as { params?: { name?: string; arguments?: unknown } }).params ?? {};
      const message = resultErrorText(result);
      onRejected({
        tool: params.name ?? '',
        args: (params.arguments as Record<string, unknown>) ?? {},
        message,
        durationMs: Date.now() - startedAtMs,
        schemaRejected: isArgumentValidationFailure(message),
      });
      return result;
    });
  };
  return handlerRan;
}

export function toMcpResult(result: BridgeToolResult, project: string) {
  // Wrap the bridge's tool result in MCP's content envelope. Include
  // sandbox provenance + project label in a metadata block so the calling
  // agent can always tell which target the tool hit.
  const body = {
    ...result,
    _pyric: { mode: 'sandbox', project },
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

  // Installed before the first tool registration, because that is when the SDK
  // installs the `tools/call` handler this wraps.
  let handlerRan: WeakSet<object> | null = null;
  if (options.onCallRejected) {
    handlerRan = observeRejectedCalls(server, options.onCallRejected);
  }
  const markHandlerRan = (extra: object | undefined): void => {
    if (handlerRan && extra) handlerRan.add(extra);
  };

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
      async (args: Record<string, unknown>, extra: object | undefined) => {
        markHandlerRan(extra);
        const result = await bridge.dispatch(meta.name, args ?? {});
        return toMcpResult(result, bridge.project);
      },
    );
  }

  // In-process tools are sandbox verification and rules helpers that do not
  // touch real Firebase. Execute them directly and record the result.
  for (const handler of options.inProcess) {
    const shape = jsonSchemaToZodShape(handler.parameters as never);
    (server.tool as unknown as Function)(
      handler.name,
      handler.description,
      shape,
      async (args: Record<string, unknown>, extra: object | undefined) => {
        markHandlerRan(extra);
        const startedAtMs = Date.now();
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
            mode: 'sandbox',
            project: bridge.project,
            tool: handler.name,
            args: args ?? {},
            result: normalised,
            durationMs: Date.now() - startedAtMs,
          });
          return toMcpResult(normalised, bridge.project);
        } catch (err) {
          const result = {
            ok: false,
            summary: err instanceof Error ? err.message : String(err),
          };
          bridge.recordToolEvent({
            timestamp: new Date(startedAtMs).toISOString(),
            mode: 'sandbox',
            project: bridge.project,
            tool: handler.name,
            args: args ?? {},
            result,
            durationMs: Date.now() - startedAtMs,
          });
          return toMcpResult(result, bridge.project);
        }
      },
    );
  }

  return server;
}
