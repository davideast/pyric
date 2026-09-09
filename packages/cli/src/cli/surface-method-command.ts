/**
 * The registry entry one method record contributes to the CLI.
 *
 * The runner is imported when a command actually runs, not when the registry is
 * built. A record's import graph reaches the sandbox, the rules engines, and the
 * conformance model, and `pyric --help` must not pay for any of it.
 */
import type { ServiceCommandHandler } from './service-commands.js';

/** The handler that runs one `pyric <tool> <method>` command. */
export function surfaceMethodCommand(key: string): ServiceCommandHandler {
  return async (parsed) => {
    const { runSurfaceMethod } = await import('./surface-method-runner.js');
    return await runSurfaceMethod(key, parsed);
  };
}
