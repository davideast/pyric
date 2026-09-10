/**
 * Effect enforcement (ADR-0014 Decision 5): the server, not the caller,
 * decides whether a call runs.
 *
 * `destructive` and `production` are declared on every record, but they are
 * enforced here, once, and the two callers that dispatch a method call
 * through it: `render/sdk-service.ts` for the MCP path and
 * `cli/surface-method-runner.ts` for the CLI path. Neither renders its own
 * copy of either check.
 *
 * `destructive` is a per-call refusal: `refuseUnconfirmedDestructive` is
 * called from `validateArguments`, so both paths get it for free. `production`
 * is two things: whether a method can be seen at all (`mountedMethods` /
 * `mountedTool`, which the MCP renderer uses to build the tool list a client
 * sees) and whether a call that already knows the method's name may run
 * (`refuseUnmountedProduction`, also folded into `validateArguments`, which is
 * what the CLI relies on since its commands are generated ahead of any
 * runtime flag and therefore cannot be hidden the way an MCP tool list can).
 */
import type { Args, Fail, InvalidArguments, Method, Tool } from './method-types.js';

/** The flag that mounts a `production` method. Named in every refusal. */
export const ALLOW_PRODUCTION_FLAG = '--allow-production';

/**
 * Refuse a `destructive` call that did not pass `confirm: true`. Returns null
 * for every other effect, and for a destructive call that did confirm.
 */
export function refuseUnconfirmedDestructive(
  method: Method,
  args: Args,
  fail: Fail,
): InvalidArguments | null {
  if (method.effect !== 'destructive') return null;
  if (args.confirm === true) return null;
  return fail(method.description, 'Pass confirm: true to proceed.', 'confirm');
}

/**
 * Refuse a `production` call unless the server was started with
 * `--allow-production`. Returns null for every other effect, and for a
 * production call when production is allowed.
 */
export function refuseUnmountedProduction(
  method: Method,
  allowProduction: boolean,
  fail: Fail,
): InvalidArguments | null {
  if (method.effect !== 'production') return null;
  if (allowProduction) return null;
  return fail(
    `${method.description} This touches Google infrastructure or real credentials, so it is not mounted by default.`,
    `Restart the server with ${ALLOW_PRODUCTION_FLAG} to run it.`,
  );
}

/** Whether a method is mounted: every effect but `production` always is. */
export function isMounted(method: Method, allowProduction: boolean): boolean {
  return method.effect !== 'production' || allowProduction;
}

/** A method list filtered to what is mounted. Order is preserved. */
export function mountedMethods(
  methods: readonly Method[],
  allowProduction: boolean,
): readonly Method[] {
  if (allowProduction) return methods;
  return methods.filter((method) => isMounted(method, allowProduction));
}

/**
 * A tool filtered to its mounted methods only. Returns the same reference when
 * nothing is filtered, so a caller can tell a genuinely unfiltered tool apart
 * from one that lost a production method.
 */
export function mountedTool(tool: Tool, allowProduction: boolean): Tool {
  const methods = mountedMethods(tool.methods, allowProduction);
  if (methods === tool.methods || methods.length === tool.methods.length) return tool;
  return { ...tool, methods };
}
