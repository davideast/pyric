/**
 * Effect enforcement (ADR-0014 Decision 5): the server, not the caller,
 * decides whether a call runs, and this is the one module that reads whether
 * production is allowed at all.
 *
 * `destructive` and `production` are declared on every record and enforced
 * here, once. Both refusals are folded into `validateArguments`, so the MCP
 * path (`render/sdk-service.ts`) and the CLI path
 * (`cli/surface-method-runner.ts`) get them without either rendering its own
 * copy.
 *
 * The production model is opt-in and visible. A `production` method is always
 * listed, under a heading that says it is disabled and names the flag that
 * enables it, and `describe` answers for it with that status, so an agent
 * reads what the surface can do and why this part of it will not run rather
 * than discovering a capability by guessing at a name that is not there. What
 * the opt-in gates is the call: without the flag every call to a production
 * method is refused with the same sentence the heading carries, and with the
 * flag the call still has to confirm.
 */
import type { Args, Fail, InvalidArguments, Method } from './method-types.js';

/** The flag that enables a `production` method. Named in the heading and in every refusal. */
export const ALLOW_PRODUCTION_FLAG = '--allow-production';

/** The environment variable that enables `production` methods when the flag is absent. */
export const ALLOW_PRODUCTION_ENV_KEY = 'PYRIC_ALLOW_PRODUCTION';

/**
 * The only two values of `PYRIC_ALLOW_PRODUCTION` that enable production
 * methods. The variable takes an exact word rather than anything truthy:
 * enabling these methods hands a session real credentials and real Google
 * infrastructure, so a variable set for some neighbouring purpose, or set to a
 * word a reader would take for a refusal, opts nobody in.
 */
const ALLOW_PRODUCTION_ENV_VALUES: readonly string[] = ['1', 'true'];

/**
 * Whether `production` methods run. The flag wins over the environment; absent
 * both, they do not. Every process that owns a sandbox reads it here: the
 * headless MCP server and `pyric <tool> <method>` alike.
 */
export function allowProductionFrom(flagPresent: boolean, env: NodeJS.ProcessEnv): boolean {
  if (flagPresent) return true;
  const value = env[ALLOW_PRODUCTION_ENV_KEY];
  if (value === undefined) return false;
  return ALLOW_PRODUCTION_ENV_VALUES.includes(value);
}

/** The heading a description lists disabled production methods under. */
export const PRODUCTION_DISABLED_HEADING = `Production methods, disabled: start the server with ${ALLOW_PRODUCTION_FLAG}`;

/** The heading a description lists production methods under once they are enabled. */
export const PRODUCTION_ENABLED_HEADING = `Production methods, enabled, which require confirm: true`;

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
 * Refuse a `production` call unless the process that owns the sandbox was
 * started with `--allow-production`. The refusal carries the same sentence the
 * description's heading carries, so the reason a call failed reads as the
 * reason the listing already gave.
 */
export function refuseUnmountedProduction(
  method: Method,
  allowProduction: boolean,
  fail: Fail,
): InvalidArguments | null {
  if (method.effect !== 'production') return null;
  if (allowProduction) return null;
  return fail(
    `${method.description} It reaches Google infrastructure with real credentials. ${PRODUCTION_DISABLED_HEADING}.`,
    `Use ${ALLOW_PRODUCTION_FLAG} on the process that owns this sandbox, then call again.`,
  );
}

/**
 * Refuse an enabled `production` call that did not pass `confirm: true`. The
 * flag opts a session in to the capability; the confirmation opts one call in
 * to spending it.
 */
export function refuseUnconfirmedProduction(
  method: Method,
  args: Args,
  fail: Fail,
): InvalidArguments | null {
  if (method.effect !== 'production') return null;
  if (args.confirm === true) return null;
  return fail(
    `${method.description} It reaches Google infrastructure with real credentials.`,
    'Pass confirm: true to proceed.',
    'confirm',
  );
}
