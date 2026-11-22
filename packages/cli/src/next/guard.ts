/**
 * Execution policies and safety interlocks for Next.js configuration loading.
 */
import type { PyricNextOptions } from './types.js';
import { isRegisterActive } from '../register/activation.js';

const FORCED_SANDBOX_FLAG = '1';

/** Next phases that compile or serve a production build. */
const PRODUCTION_PHASES: ReadonlySet<string> = new Set([
  'phase-production-build',
  'phase-production-server',
  'phase-export',
]);

/**
 * Check whether the Next phase requires production passthrough without Pyric
 * sandbox module substitution. The phase is what Next is doing; NODE_ENV can
 * be exported by the shell and disagree with it.
 */
export function isProductionPassthrough(phase: string): boolean {
  if (!PRODUCTION_PHASES.has(phase)) {
    return false;
  }
  return process.env.PYRIC_SANDBOX_FORCE !== FORCED_SANDBOX_FLAG;
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

const OPT_OUT = 'To disable this guard, pass { guard: false } to withPyric(config, options).';

const NO_SANDBOX_MESSAGE =
  '[Pyric] Next.js development server started without active Pyric sandbox environment variables.\n' +
  'To prevent accidental connections to production Firebase databases, launch this server using:\n' +
  '  pyric sandbox -- next dev\n' +
  'or start the host alone with `pyric sandbox --no-run` and paste the printed export lines into the terminal that runs next dev.\n' +
  OPT_OUT;

/**
 * `PYRIC_SANDBOX` is set but the register didn't load, so route handlers
 * would import the real `firebase-admin` (#1625, #1654). Next sets
 * `NODE_ENV=development` before evaluating `next.config`, so the guard names
 * each cause alongside its own fix rather than leading with one launch command.
 */
const NO_REGISTER_MESSAGE =
  '[Pyric] PYRIC_SANDBOX is set, but @pyric/cli/register is not active in this process, ' +
  'so firebase-admin and firebase imports in route handlers would load the real SDKs.\n' +
  'Next sets NODE_ENV=development before loading next.config, so check how this server was started:\n' +
  '  - PYRIC_SANDBOX came from a .env file or shell export without the launcher: ' +
  'put pyric sandbox in front of the command (`pyric sandbox -- next dev` or `pyric sandbox -- npm run dev`).\n' +
  '  - NODE_ENV=production was set in the shell when starting `pyric sandbox -- next dev`, making the register refuse: ' +
  'unset NODE_ENV (or set NODE_ENV=development) and run `pyric sandbox -- next dev`.\n' +
  '  - A package script overwrites NODE_OPTIONS (for example `NODE_OPTIONS=--max-old-space-size=4096 next dev`), dropping the register: ' +
  'put pyric sandbox in front of the npm script and append to the inherited value (`NODE_OPTIONS="$NODE_OPTIONS --max-old-space-size=4096" next dev`).\n' +
  '  - Next was started under Bun (for example `bun --bun next dev`), which does not run Node module.registerHooks: ' +
  'run the dev server under Node (`pyric sandbox -- next dev`).\n' +
  OPT_OUT;

/**
 * Verify that the Next.js development server is starting under an active
 * sandbox: `PYRIC_SANDBOX` is set and `@pyric/cli/register` activated in this
 * process. Throws a terminal error naming how to start it otherwise.
 */
export function enforceSandboxGuard(options?: PyricNextOptions): void {
  if (isGuardExplicitlyDisabled(options)) {
    return;
  }
  if (!hasActiveSandboxEnvironment()) {
    throw new Error(NO_SANDBOX_MESSAGE);
  }
  if (!isRegisterActive()) {
    throw new Error(NO_REGISTER_MESSAGE);
  }
}
