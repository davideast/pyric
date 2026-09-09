/**
 * The `sdk-service` variant: one tool per Firebase service, discriminated by the
 * SDK's own method name and carrying the SDK's own argument names.
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
import { toJsonSchema } from '../json-schema.js';
import { operationById } from '../operations/index.js';
import {
  DESCRIBE_METHOD,
  SDK_TOOLS,
  sdkMethodByName,
  sdkToolByName,
  validateArguments,
  validateDescribe,
  validateMethodName,
} from '../sdk-validator.js';
import type { Args, MethodSpec, ToolSpec } from '../sdk-validator.js';
import type {
  Operation,
  OperationResult,
  RenderedSurface,
  RenderedTool,
  ResolvedCall,
  SurfaceContext,
} from '../types.js';

/** The longest a rendered description may be. */
const DESCRIPTION_LIMIT = 1200;

/** The `args` object a client sees, which every method fills differently. */
const ARGS_DESCRIPTION =
  'The arguments of the named method, under the SDK argument names. Call describe for one method schema.';

/** One tool description: the service, the method list, and the describe sentence. */
export function describeTool(tool: ToolSpec): string {
  const methods = tool.methods
    .map((method) => `${method.signature}: ${method.summary}`)
    .join(' ');
  const description = `${tool.intro} Methods: ${methods} Call method '${DESCRIBE_METHOD}' with args { method } to read the full schema and an example call for one method.`;
  if (description.length > DESCRIPTION_LIMIT) {
    throw new Error(
      `${tool.name} description is ${description.length} characters, over the ${DESCRIPTION_LIMIT} limit`,
    );
  }
  return description;
}

/** The top-level schema, which is the same two properties for every tool. */
export function toolSchema(tool: ToolSpec): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      method: {
        type: 'string',
        enum: [...tool.methods.map((method) => method.name), DESCRIBE_METHOD],
      },
      args: {
        type: 'object',
        additionalProperties: true,
        description: ARGS_DESCRIPTION,
      },
    },
    required: ['method', 'args'],
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
function describeMethod(tool: ToolSpec, method: MethodSpec): OperationResult {
  return {
    ok: true,
    summary: `${tool.name}.${method.name}: ${method.signature}`,
    data: {
      tool: tool.name,
      method: method.name,
      signature: method.signature,
      summary: method.summary,
      operations: [...method.operations],
      inputSchema: toJsonSchema(method.args),
      example: { method: method.name, args: method.example },
    },
  };
}

/** Run one method against its canonical operation, after the validator passes. */
async function runMethod(
  tool: ToolSpec,
  method: MethodSpec,
  args: Args,
  ctx: SurfaceContext,
): Promise<OperationResult> {
  const rejection = validateArguments(tool, method, args);
  if (rejection !== null) return rejection;
  return operationById(method.resolve(args)).handler(method.translate(args), ctx);
}

/** One method, past the point where the validator has already accepted its name. */
function methodOrThrow(tool: ToolSpec, name: string): MethodSpec {
  const method = sdkMethodByName(tool, name);
  if (method === undefined) throw new Error(`${tool.name} has no method '${name}'`);
  return method;
}

async function execute(tool: ToolSpec, raw: Args, ctx: SurfaceContext): Promise<OperationResult> {
  const named = validateMethodName(tool, raw.method);
  if (named !== null) return named;
  const args = argsOf(raw);
  const methodName = String(raw.method);
  if (methodName === DESCRIBE_METHOD) {
    const rejection = validateDescribe(tool, args);
    if (rejection !== null) return rejection;
    return describeMethod(tool, methodOrThrow(tool, String(args.method)));
  }
  return runMethod(tool, methodOrThrow(tool, methodName), args, ctx);
}

/**
 * The canonical operation a call reaches, tolerant of arguments the validator
 * would reject, so a rejected call is still logged under the operation it was
 * reaching for rather than under nothing.
 */
function resolveCall(known: ReadonlySet<string>, toolName: string, raw: Args): ResolvedCall {
  const tool = sdkToolByName(toolName);
  const method = typeof raw.method === 'string' ? raw.method : null;
  if (tool === undefined || method === null) return { operation: null, action: method };
  const spec = sdkMethodByName(tool, method);
  if (spec === undefined) return { operation: null, action: method };
  let operation: string | null = null;
  try {
    operation = spec.resolve(argsOf(raw));
  } catch {
    operation = null;
  }
  if (operation !== null && !known.has(operation)) operation = null;
  return { operation, action: method };
}

export function render(operations: readonly Operation[]): RenderedSurface {
  const known = new Set(operations.map((operation) => operation.id));
  const covered = SDK_TOOLS.flatMap((tool) =>
    tool.methods.flatMap((method) => [...method.operations]),
  );
  for (const id of covered) {
    if (!known.has(id)) throw new Error(`sdk-service names unknown operation '${id}'`);
  }
  if (new Set(covered).size !== known.size || covered.length !== known.size) {
    throw new Error(
      `sdk-service reaches ${new Set(covered).size} of ${known.size} operations across ${covered.length} method mappings`,
    );
  }

  const tools: RenderedTool[] = SDK_TOOLS.map((tool) => ({
    name: tool.name,
    description: describeTool(tool),
    inputSchema: toolSchema(tool),
    execute: (args, ctx) => execute(tool, args, ctx),
  }));

  return {
    tools,
    resolve: (toolName, args) => resolveCall(known, toolName, args),
  };
}
