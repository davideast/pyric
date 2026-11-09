/**
 * Node `< 22.15` hard stop (ADR 0023).
 *
 * `@pyric/cli` requires Node `>= 22.15` so synchronous `module.registerHooks`
 * intercepts both ESM `import` and CommonJS `require()` before any real
 * Firebase SDK file executes. Without `module.registerHooks`, CommonJS
 * `require('firebase-admin')` cannot be swapped or stopped and would reach
 * live Firebase.
 */

export const UNSUPPORTED_NODE_VERSION_CODE = 'PYRIC_UNSUPPORTED_NODE_VERSION';

export function createUnsupportedNodeVersionError(
  surface: string = '@pyric/cli/register',
  nodeVersion: string = process.versions.node,
): Error & { code: string } {
  const message =
    `${surface}: Node ${nodeVersion} lacks module.registerHooks (requires Node >= 22.15).\n` +
    "  Without synchronous module.registerHooks, CommonJS require('firebase-admin') cannot be swapped or stopped and would reach live Firebase.\n" +
    '  Upgrade Node to >= 22.15.\n' +
    `  code: ${UNSUPPORTED_NODE_VERSION_CODE}`;
  const error = new Error(message) as Error & { code: string };
  error.code = UNSUPPORTED_NODE_VERSION_CODE;
  return error;
}

export function requireRegisterHooks<T extends (...args: never[]) => unknown>(
  registerHooks: T | undefined,
  surface: string = '@pyric/cli/register',
  nodeVersion: string = process.versions.node,
  write?: (line: string) => void,
): T {
  if (typeof registerHooks === 'function') {
    return registerHooks;
  }
  const error = createUnsupportedNodeVersionError(surface, nodeVersion);
  write?.(`${error.message}\n`);
  throw error;
}
