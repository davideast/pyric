/**
 * Execution policies and safety interlocks for Next.js configuration loading.
 */
import type { PyricNextOptions } from './types.js';

const PRODUCTION_ENVIRONMENT = 'production';
const FORCED_SANDBOX_FLAG = '1';

/**
 * Check whether the active environment requires production build passthrough
 * without Pyric sandbox module substitution.
 */
export function isProductionPassthrough(): boolean {
  const isProductionEnv = process.env.NODE_ENV === PRODUCTION_ENVIRONMENT;
  const isForcedOverride = process.env.PYRIC_SANDBOX_FORCE === FORCED_SANDBOX_FLAG;
  if (!isProductionEnv) {
    return false;
  }
  return !isForcedOverride;
}

/**
 * Check whether the developer opted out of the sandbox environment guard.
 */
function isGuardExplicitlyDisabled(options?: PyricNextOptions): boolean {
  if (options === undefined) {
    return false;
  }
  return options.guard === false;
}

/**
 * Check whether an active Pyric sandbox environment variable is present in the process.
 */
function hasActiveSandboxEnvironment(): boolean {
  const sandboxValue = process.env.PYRIC_SANDBOX;
  if (sandboxValue === undefined) {
    return false;
  }
  return sandboxValue.length > 0;
}

/**
 * Verify whether the Next.js development server is booting under a secure,
 * activated sandbox environment. Throws a protective terminal error if un-sandboxed.
 */
export function enforceSandboxGuard(options?: PyricNextOptions): void {
  if (isGuardExplicitlyDisabled(options)) {
    return;
  }
  if (hasActiveSandboxEnvironment()) {
    return;
  }
  const errorMessage =
    '[Pyric] Next.js development server started without active Pyric sandbox environment variables.\n' +
    'To prevent accidental connections to production Firebase databases, launch this server using:\n' +
    '  pyric dev -- next dev\n' +
    'or source environment keys via `pyric env`.\n' +
    'To disable this guard, pass { guard: false } to withPyric(config, options).';
  throw new Error(errorMessage);
}
