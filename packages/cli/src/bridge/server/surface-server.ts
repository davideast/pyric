/**
 * Register a rendered tool surface on an MCP server.
 *
 * `buildMcpServer` registers the default surface, whose two halves (forwarded
 * families and in-process handlers) it knows about directly. A variant surface
 * is already flattened by the time it reaches here: one list of rendered tools
 * with an `execute`, an optional list of resource templates with a `read`, and
 * a resolver from a rendered name back to the canonical operation. This module
 * is the one place that turns that shape into SDK registrations, so a variant
 * never learns anything about the MCP SDK and the server never learns anything
 * about how a variant spells its names.
 *
 * Every call, tool or resource, records exactly one `BridgeToolEvent` through
 * the bridge, carrying the canonical operation and the discriminator action the
 * surface resolved. That is the join key the evaluation log, the corpus, and
 * the scorer share, and it is stamped here because this is the only layer that
 * sees both the name the client sent and the operation it reached.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Bridge, BridgeToolEvent } from './bridge.js';
import { jsonSchemaToZodShape } from './json-schema-to-zod.js';
import { observeRejectedCalls, toMcpResult, type RejectedToolCall } from './mcp.js';
import {
  DENIED_BY_RULES_CODE,
  LINT_FINDINGS_CODE,
} from '../surface/rules-verdict.js';
import type {
  OperationResult,
  RenderedResource,
  RenderedSurface,
  RenderedTool,
  SurfaceContext,
} from '../surface/types.js';

export interface RegisterRenderedSurfaceOptions {
  /**
   * Called for a `tools/call` the SDK refuses before any handler runs, so a
   * schema rejection is still observable. Absent leaves the server as the SDK
   * built it.
   */
  onCallRejected?: (rejection: RejectedToolCall) => void;
  /**
   * Called after every finished call, tool or resource. The in-process runner
   * schedules its debounced snapshot flush here, the way the local bridge's
   * `onAfterDispatch` does for the default surface.
   */
  onAfterCall?: () => void;
}

/** MIME type of a resource read body, which is the operation result as JSON. */
const RESOURCE_MIME_TYPE = 'application/json';

/**
 * Spell a resource template so the SDK's RFC 6570 matcher accepts a value that
 * carries slashes. A bare `{path}` matches one segment, and the paths these
 * templates carry (`rooms/r1/msgs/m1`) are many; reserved expansion, `{+path}`,
 * is the form that matches the whole tail. The rendered surface keeps its own
 * spelling, so the resolver and the read still see the template as authored.
 */
function sdkUriTemplate(uriTemplate: string): string {
  return uriTemplate.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '{+$1}');
}

/**
 * Whether a result is a surface's own argument rejection. A variant that
 * validates arguments itself, rather than leaving it to the client's schema
 * checker, refuses the call before any handler runs and says so in the result.
 * Recording that the same way as an SDK-level rejection is what keeps the
 * argument-validity metric comparable across variants: the agent got the
 * arguments wrong either way, and where the refusal happened is an accident of
 * how thin the variant's top-level schema is.
 */
function isArgumentRejection(result: OperationResult): boolean {
  if (result.ok) return false;
  const data = result.data;
  if (data === null || typeof data !== 'object') return false;
  return (data as { code?: unknown }).code === 'invalid_arguments';
}

/**
 * Result codes that report a verdict rather than a fault. A data-plane call
 * Security Rules refused is the enforcement working, and a lint run that found
 * problems is the linter working. Both come back as a failing result because
 * the answer is negative, not because the call went wrong.
 */
const VERDICT_CODES: ReadonlySet<string> = new Set([
  DENIED_BY_RULES_CODE,
  LINT_FINDINGS_CODE,
]);

/**
 * Whether a result is the surface reporting a verdict. The call reached its
 * handler, the handler ran, and the answer is a refusal or a set of findings.
 * Counting either as an error call would score a surface down for telling the
 * truth it was asked for, so the event carries the distinction and the scorer
 * reads it back.
 */
function isVerdictResult(result: OperationResult): boolean {
  if (result.ok) return false;
  const data = result.data;
  if (data === null || typeof data !== 'object') return false;
  const code = (data as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  return VERDICT_CODES.has(code);
}

/** The operation result shape, from whatever a handler returned. */
function normalise(result: OperationResult): OperationResult {
  return { ok: result.ok, summary: result.summary, data: result.data };
}

function failure(err: unknown): OperationResult {
  return { ok: false, summary: err instanceof Error ? err.message : String(err) };
}

/** Record one finished call, with the operation and action the surface resolved. */
function recordCall(
  bridge: Bridge,
  fields: {
    tool: string;
    args: Record<string, unknown>;
    result: OperationResult;
    startedAtMs: number;
    operation: string | null;
    action: string | null;
  },
): void {
  const event: BridgeToolEvent = {
    timestamp: new Date(fields.startedAtMs).toISOString(),
    mode: 'sandbox',
    project: bridge.project,
    tool: fields.tool,
    args: fields.args,
    result: fields.result,
    durationMs: Date.now() - fields.startedAtMs,
    operation: fields.operation,
    action: fields.action,
    schemaRejected: isArgumentRejection(fields.result),
    isError: !fields.result.ok,
    verdict: isVerdictResult(fields.result),
  };
  bridge.recordToolEvent(event);
}

function registerTool(
  server: McpServer,
  bridge: Bridge,
  surface: RenderedSurface,
  tool: RenderedTool,
  ctx: SurfaceContext,
  options: RegisterRenderedSurfaceOptions,
  markHandlerRan: (extra: object | undefined) => void,
): void {
  const shape = jsonSchemaToZodShape(tool.inputSchema as never);
  // The SDK's `tool()` overloads have a generic tree deep enough to trip
  // `Type instantiation is excessively deep` on the variadic shape argument.
  // The cast collapses the inference; the runtime contract is unchanged, and
  // `buildMcpServer` registers its own tools the same way.
  (server.tool as unknown as Function)(
    tool.name,
    tool.description,
    shape,
    async (args: Record<string, unknown>, extra: object | undefined) => {
      markHandlerRan(extra);
      const startedAtMs = Date.now();
      const callArgs = args ?? {};
      let result: OperationResult;
      try {
        result = normalise(await tool.execute(callArgs, ctx));
      } catch (err) {
        result = failure(err);
      }
      const resolved = surface.resolve(tool.name, callArgs);
      recordCall(bridge, {
        tool: tool.name,
        args: callArgs,
        result,
        startedAtMs,
        operation: resolved.operation,
        action: resolved.action,
      });
      options.onAfterCall?.();
      return toMcpResult(result, bridge.project);
    },
  );
}

function registerResource(
  server: McpServer,
  bridge: Bridge,
  surface: RenderedSurface,
  resource: RenderedResource,
  ctx: SurfaceContext,
  options: RegisterRenderedSurfaceOptions,
): void {
  const template = new ResourceTemplate(sdkUriTemplate(resource.uriTemplate), { list: undefined });
  (server.resource as unknown as Function)(
    resource.name,
    template,
    { description: resource.description, mimeType: RESOURCE_MIME_TYPE },
    async (uri: URL, variables: Record<string, unknown>) => {
      const startedAtMs = Date.now();
      const requested = uri.toString();
      let result: OperationResult;
      try {
        result = normalise(await resource.read(requested, ctx));
      } catch (err) {
        result = failure(err);
      }
      // A resource read carries no arguments of its own: the uri and the
      // template variables the SDK parsed out of it are what the event records.
      const args: Record<string, unknown> = { uri: requested, ...variables };
      const resolved = surface.resolve(resource.name, args);
      recordCall(bridge, {
        tool: resource.name,
        args,
        result,
        startedAtMs,
        operation: resolved.operation,
        action: resolved.action,
      });
      options.onAfterCall?.();
      const body = { ...result, _pyric: { mode: 'sandbox', project: bridge.project } };
      return {
        contents: [
          { uri: requested, mimeType: RESOURCE_MIME_TYPE, text: JSON.stringify(body, null, 2) },
        ],
      };
    },
  );
}

/**
 * Register every rendered tool and resource template of one surface. The
 * rejection observer is installed first, because the SDK installs the
 * `tools/call` handler it wraps during the first tool registration.
 */
export function registerRenderedSurface(
  server: McpServer,
  bridge: Bridge,
  surface: RenderedSurface,
  ctx: SurfaceContext,
  options: RegisterRenderedSurfaceOptions = {},
): McpServer {
  let handlerRan: WeakSet<object> | null = null;
  if (options.onCallRejected) {
    handlerRan = observeRejectedCalls(server, options.onCallRejected);
  }
  const markHandlerRan = (extra: object | undefined): void => {
    if (handlerRan && extra) handlerRan.add(extra);
  };

  for (const tool of surface.tools) {
    registerTool(server, bridge, surface, tool, ctx, options, markHandlerRan);
  }
  for (const resource of surface.resources ?? []) {
    registerResource(server, bridge, surface, resource, ctx, options);
  }
  return server;
}
