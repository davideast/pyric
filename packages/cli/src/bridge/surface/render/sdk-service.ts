/**
 * The `sdk-service` surface: one tool per Firebase service, discriminated by
 * the SDK's own method name and carrying the SDK's own argument names.
 *
 * The top-level schema is deliberately thin. `method` is an enum and `args` is
 * an open object, so the client's schema checker can catch a method that does
 * not exist and nothing else. Everything a per-method schema would have caught
 * is caught by the validator instead, which can say more than a schema can: not
 * only that `claims` is not an argument, but that the SDK calls it
 * `customClaims`; not only that a path is a string, but that a document path
 * has an even number of segments.
 *
 * Every tool also answers `describe`, which returns one method's full schema and
 * an example call. That is the escape hatch the thin top-level schema costs: an
 * agent that cannot read the arguments off the tool list can ask for them.
 */
import { TOOL_DESCRIPTIONS } from '../descriptions.generated.js';
import { toJsonSchema } from '../json-schema.js';
import { callMethod } from '../method-call.js';
import { mountedTool } from '../method-effects.js';
import { methodByName, TOOLS, toolByName } from '../methods/registry.js';
import {
  DESCRIBE_METHOD,
  methodNames,
  validateDescribe,
  validateMethodName,
} from '../method-validation.js';
import { renderToolDescription } from '../tool-description.js';
import { operationIds, selectOperation } from '../method-types.js';
import type { Args, Method, Tool } from '../method-types.js';
import type {
  OperationResult,
  RenderedSurface,
  RenderedTool,
  RenderOptions,
  ResolvedCall,
  SurfaceContext,
} from '../types.js';

/** The `args` object a client sees, which every method fills differently. */
const ARGS_DESCRIPTION =
  'The arguments of the named method, under the SDK argument names. Call describe for one method schema.';

/**
 * The description one tool serves, which the build renders from its records.
 *
 * A tool whose mounted methods equal the source record's methods (the case
 * every tool is in today: no `production` method exists yet) gets the
 * generated description as-is. A tool that lost a method to production
 * gating is described from its mounted methods only, so an unmounted method
 * never appears in a description a client reads.
 */
export function describeTool(tool: Tool): string {
  const source = toolByName(tool.name);
  if (source !== undefined && source.methods.length === tool.methods.length) {
    const description = TOOL_DESCRIPTIONS[tool.name];
    if (description === undefined) {
      throw new Error(`no generated description for tool '${tool.name}'; run scripts/generate-surface-descriptions.ts`);
    }
    return description;
  }
  return renderToolDescription(tool);
}

/**
 * The top-level schema, which is the same two properties for every tool.
 *
 * `args` is optional: a method that takes no arguments, or one whose
 * arguments are all optional, must be callable as `{ method }` alone. The
 * validator already treats a missing `args` as `{}`, so requiring it at the
 * schema level only rejected calls the handler would have accepted.
 */
export function toolSchema(tool: Tool): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      method: { type: 'string', enum: methodNames(tool) },
      args: {
        type: 'object',
        additionalProperties: true,
        description: ARGS_DESCRIPTION,
      },
    },
    required: ['method'],
  };
}

/** The `args` object of a call, or an empty object when the client sent none. */
function argsOf(raw: Args): Args {
  const supplied = raw.args;
  if (supplied === null || supplied === undefined || typeof supplied !== 'object') return {};
  if (Array.isArray(supplied)) return {};
  return supplied as Args;
}

/** One method's schema and example, as `describe` returns them. */
function describeMethod(method: Method): OperationResult {
  return {
    ok: true,
    summary: `${method.key}: ${method.signature}`,
    data: {
      tool: method.tool,
      method: method.method,
      signature: method.signature,
      summary: method.description,
      effect: method.effect,
      operations: [...operationIds(method)],
      inputSchema: toJsonSchema(method.args),
      example: { method: method.method, args: method.example },
    },
  };
}

/** One method, past the point where the validator has already accepted its name. */
function methodOrThrow(tool: Tool, name: string): Method {
  const method = methodByName(tool, name);
  if (method === undefined) throw new Error(`${tool.name} has no method '${name}'`);
  return method;
}

async function execute(
  tool: Tool,
  raw: Args,
  ctx: SurfaceContext,
  allowProduction: boolean,
): Promise<OperationResult> {
  const named = validateMethodName(tool, raw.method);
  if (named !== null) return named;
  const args = argsOf(raw);
  const methodName = String(raw.method);
  if (methodName === DESCRIBE_METHOD) {
    const rejection = validateDescribe(tool, args);
    if (rejection !== null) return rejection;
    return describeMethod(methodOrThrow(tool, String(args.method)));
  }
  return callMethod(methodOrThrow(tool, methodName), args, ctx, allowProduction);
}

/**
 * The canonical operation a call reaches, tolerant of arguments the validator
 * would reject, so a rejected call is still logged under the operation it was
 * reaching for rather than under nothing.
 */
function resolveCall(toolName: string, raw: Args): ResolvedCall {
  const tool = toolByName(toolName);
  const named = typeof raw.method === 'string' ? raw.method : null;
  if (tool === undefined || named === null) return { operation: null, action: named };
  const method = methodByName(tool, named);
  if (method === undefined) return { operation: null, action: named };
  return { operation: selectOperation(method, argsOf(raw)), action: named };
}

export function render(options?: RenderOptions): RenderedSurface {
  const allowProduction = options?.allowProduction ?? false;
  const tools: RenderedTool[] = TOOLS.map((tool) => {
    const mounted = mountedTool(tool, allowProduction);
    // A tool whose every method is withheld would serve a `method` enum holding
    // nothing but `describe`, which is a tool with no capability behind it.
    if (mounted.methods.length === 0) {
      throw new Error(`service tool '${mounted.name}' mounts no methods`);
    }
    return {
      name: mounted.name,
      description: describeTool(mounted),
      inputSchema: toolSchema(mounted),
      execute: (args, ctx) => execute(mounted, args, ctx, allowProduction),
    };
  });
  return { tools, resolve: resolveCall };
}
