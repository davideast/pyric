/**
 * The execution context a method record gets wherever the sandbox lives.
 *
 * Its dispatcher reaches only the forwarded tool families, through the same
 * `buildSandboxDispatcher` the page and the SharedWorker already run, and it
 * reads no file. A host that keeps its sandbox in a browser can therefore
 * build one and run any record marked `runsIn: 'sandbox'` against it. The
 * bridge process builds the wider context in `./context.ts` on top of this one.
 */
import type { LocalSandbox } from 'pyric/sandbox';
import { buildSandboxDispatcher } from '../client/dispatch.js';
import { accountLookupFor } from './app-session.js';
import type { DatabaseInstanceCatalog } from './database-instance-catalog.js';
import { SurfaceIdentity } from './identity.js';
import type { OperationResult, SandboxSurfaceContext } from './types.js';

/**
 * Build the context for one sandbox. `databaseInstances` answers which RTDB
 * instances a `database` method may name, from what the host serves.
 */
export function createSandboxSurfaceContext(
  sandbox: LocalSandbox,
  databaseInstances: () => Promise<DatabaseInstanceCatalog>,
): SandboxSurfaceContext {
  return {
    sandbox,
    dispatch: buildSandboxDispatcher(sandbox),
    identity: new SurfaceIdentity(accountLookupFor(sandbox)),
    databaseInstances,
  };
}

/**
 * Call one existing sandbox tool under the held identity. Arguments are
 * objects in and objects out; nothing is JSON-encoded on the way through.
 */
export async function callSandboxTool(
  ctx: SandboxSurfaceContext,
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
