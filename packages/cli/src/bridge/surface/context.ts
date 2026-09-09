/**
 * The execution context every rendered tool hands its operation handler.
 *
 * One context per sandbox: the shared sandbox dispatcher (the same
 * `buildSandboxDispatcher` the served bridge and the headless server use, so
 * an operation that maps onto an existing tool executes exactly the code path
 * that tool always did) plus the caller identity the surface holds.
 */
import type { LocalSandbox } from 'pyric/sandbox';
import { buildSandboxDispatcher } from '../client/dispatch.js';
import { SurfaceIdentity } from './identity.js';
import type { OperationResult, SurfaceContext } from './types.js';

/** Build the context for one sandbox. */
export function createSurfaceContext(sandbox: LocalSandbox): SurfaceContext {
  return {
    sandbox,
    dispatch: buildSandboxDispatcher(sandbox),
    identity: new SurfaceIdentity(),
  };
}

/**
 * Call one existing sandbox tool under the held identity. Arguments are
 * objects in and objects out; nothing is JSON-encoded on the way through.
 */
export async function callSandboxTool(
  ctx: SurfaceContext,
  name: string,
  args: Record<string, unknown>,
): Promise<OperationResult> {
  return ctx.dispatch(name, args, ctx.identity.lens());
}

/** Report a failure in the shape every handler returns. */
export function operationFailure(summary: string, data?: unknown): OperationResult {
  if (data === undefined) return { ok: false, summary };
  return { ok: false, summary, data };
}
