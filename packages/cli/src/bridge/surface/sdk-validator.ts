/**
 * The six service tools of the `sdk-service` variant, and the entry points the
 * renderer calls to validate one call against them.
 *
 * The method tables live one file per service under `sdk-validator/`, and the
 * shapes and the failure format they share live in `sdk-validator/shared.ts`.
 * This module is the seam: it is the only place that knows the tool set is six
 * and which six, so a service added later is one import and one array entry.
 */
import { AUTH_TOOL } from './sdk-validator/auth.js';
import { DATABASE_TOOL } from './sdk-validator/database.js';
import { FIRESTORE_TOOL } from './sdk-validator/firestore.js';
import { RULES_TOOL } from './sdk-validator/rules.js';
import { SANDBOX_TOOL } from './sdk-validator/sandbox.js';
import { STORAGE_TOOL } from './sdk-validator/storage.js';
import {
  DESCRIBE_METHOD,
  failFor,
  quoted,
  validateArguments,
  validateMethodName,
} from './sdk-validator/shared.js';
import type { Args, InvalidArguments, MethodSpec, ToolSpec } from './sdk-validator/shared.js';

/** Every service tool, in the order the tool list advertises them. */
export const SDK_TOOLS: readonly ToolSpec[] = [
  FIRESTORE_TOOL,
  DATABASE_TOOL,
  STORAGE_TOOL,
  AUTH_TOOL,
  RULES_TOOL,
  SANDBOX_TOOL,
];

/** One service tool by name. */
export function sdkToolByName(name: string): ToolSpec | undefined {
  return SDK_TOOLS.find((tool) => tool.name === name);
}

/** One method of one tool by name. `describe` is not one of these. */
export function sdkMethodByName(tool: ToolSpec, name: string): MethodSpec | undefined {
  return tool.methods.find((method) => method.name === name);
}

/**
 * Check the `args` a `describe` call names. `describe` reads a method's schema,
 * so its own argument is a method name and nothing else.
 */
export function validateDescribe(tool: ToolSpec, args: Args): InvalidArguments | null {
  const fail = failFor(tool.name, DESCRIBE_METHOD);
  const names = tool.methods.map((method) => method.name);
  const named = args.method;
  if (typeof named !== 'string') {
    return fail(
      `args.method is ${quoted(named)}. describe reads one method schema, so it names the method to read.`,
      `Pass args: { method: '${names[0]}' }.`,
      'method',
    );
  }
  if (sdkMethodByName(tool, named) !== undefined) return null;
  return fail(
    `args.method is ${quoted(named)}, which ${tool.name} does not carry. Its methods are ${names.join(', ')}.`,
    `Pass args.method as one of ${names.join(', ')}.`,
    'method',
  );
}

export { DESCRIBE_METHOD, validateArguments, validateMethodName };
export type { Args, InvalidArguments, MethodSpec, ToolSpec };
