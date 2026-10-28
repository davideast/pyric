/**
 * The execution context every rendered tool hands its operation handler in
 * the bridge process.
 *
 * One context per sandbox. It widens the sandbox context (`./sandbox-context.ts`)
 * with the project directory and the in-process tool families. Its dispatcher
 * is the union of the two halves of the default surface: the forwarded families
 * through the shared `buildSandboxDispatcher`, and the in-process families (the
 * rules engine and the stdlib catalogue) through their own handlers. An
 * operation that maps onto an existing tool therefore executes exactly the code
 * path that tool always did, whichever half it lives in.
 */
import type { ToolHandler } from 'pyric/sandbox/internal';
import type { LocalSandbox } from 'pyric/sandbox';
import type { CheckpointBackend } from 'pyric/sandbox/checkpoints';
import type { SandboxDispatch } from '../client/dispatch.js';
import { getInProcessToolHandlers } from '../server/tool-metadata.js';
import { projectDatabaseInstances } from './database-instance-project.js';
import { createSandboxSurfaceContext } from './sandbox-context.js';
import type { SurfaceContext, SurfaceTargetRouter } from './types.js';

export { callSandboxTool, operationFailure } from './sandbox-context.js';

/** The minimal tool context the in-process handlers read. */
function handlerContext(): never {
  return { signal: new AbortController().signal } as never;
}

/** A dispatcher over both halves of the default tool surface. */
function withInProcessFamilies(forwarded: SandboxDispatch): SandboxDispatch {
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
 * `checkpoints` is where the host keeps checkpoints when it is not that
 * directory. The RTDB instances are read from the project's files on each
 * call, unless a host replaces `databaseInstances` with its own.
 */
export function createSurfaceContext(
  sandbox: LocalSandbox,
  projectDir: string = process.cwd(),
  targetRouter?: SurfaceTargetRouter,
  checkpoints?: CheckpointBackend,
): SurfaceContext {
  const base = createSandboxSurfaceContext(sandbox, () =>
    projectDatabaseInstances(context.sandbox, context.projectDir),
  );
  const context: SurfaceContext = {
    ...base,
    dispatch: withInProcessFamilies(base.dispatch),
    projectDir,
    targetRouter,
    checkpoints,
  };
  return context;
}
