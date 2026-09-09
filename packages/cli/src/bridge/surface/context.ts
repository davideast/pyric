/**
 * The execution context every rendered tool hands its operation handler.
 *
 * One context per sandbox. Its dispatcher is the union of the two halves of
 * the default surface: the forwarded families through the shared
 * `buildSandboxDispatcher`, and the in-process families (the rules engine and
 * the stdlib catalogue) through their own handlers. An operation that maps
 * onto an existing tool therefore executes exactly the code path that tool
 * always did, whichever half it lives in.
 */
import type { ToolHandler } from '@inbrowser/agent';
import type { LocalSandbox } from 'pyric/sandbox';
import { buildSandboxDispatcher, type SandboxDispatch } from '../client/dispatch.js';
import { getInProcessToolHandlers } from '../server/tool-metadata.js';
import { SurfaceIdentity } from './identity.js';
import type { OperationResult, SurfaceContext } from './types.js';

/** The minimal tool context the in-process handlers read. */
function handlerContext(): never {
  return { signal: new AbortController().signal } as never;
}

/** A dispatcher over both halves of the default tool surface. */
function buildSurfaceDispatch(sandbox: LocalSandbox): SandboxDispatch {
  const forwarded = buildSandboxDispatcher(sandbox);
  const inProcess = new Map<string, ToolHandler>(
    getInProcessToolHandlers().map((handler) => [handler.name, handler]),
  );
  return async (name, args, actAs) => {
    const local = inProcess.get(name);
    if (local === undefined) return forwarded(name, args, actAs);
    const result = await local.execute(args, handlerContext());
    return { ok: result.ok, summary: result.summary, data: result.data };
  };
}

/**
 * Build the context for one sandbox. `projectDir` names the directory the
 * session's `.pyric/` files live under; it defaults to the process working
 * directory, which is what a caller that never leaves its own project gets.
 */
export function createSurfaceContext(
  sandbox: LocalSandbox,
  projectDir: string = process.cwd(),
): SurfaceContext {
  return {
    sandbox,
    dispatch: buildSurfaceDispatch(sandbox),
    identity: new SurfaceIdentity(),
    projectDir,
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
