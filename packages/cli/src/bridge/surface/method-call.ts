/**
 * The one way a rendered surface runs a method record.
 *
 * Every surface the project serves reaches the same handlers, so every surface
 * has to reach them through the same checks: the argument names, the schema,
 * the destructive confirmation, the production gate, and the record's own
 * semantic rules. A renderer that called `method.handler` itself would serve a
 * surface with weaker enforcement than its neighbour, and an A/B between two
 * such surfaces would compare validation as much as naming.
 *
 * So there is one entry here, it takes the record and that record's own
 * arguments, and `render/sdk-service.ts`, `render/one-tool-per-method.ts`, and
 * `render/canonical-dispatch.ts` all call it. The CLI runner reaches the same
 * checks through `validateArguments` directly, because it reports a rejection
 * on stderr with its own exit code rather than returning it as a result.
 */
import { validateArguments } from './method-validation.js';
import type { Args, Method } from './method-types.js';
import type { OperationResult, SurfaceContext } from './types.js';

/**
 * Check one call and run it. Returns the handler's result, or the rejection the
 * caller is handed instead. `allowProduction` defaults to false, the safe
 * default a caller gets without naming it.
 */
export async function callMethod(
  method: Method,
  args: Args,
  ctx: SurfaceContext,
  allowProduction = false,
): Promise<OperationResult> {
  const rejection = validateArguments(method, args, allowProduction);
  if (rejection !== null) return rejection;
  return method.handler(args, ctx);
}
