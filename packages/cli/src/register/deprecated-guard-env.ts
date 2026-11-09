/**
 * One-line deprecation notice for legacy `PYRIC_GUARD` and `PYRIC_GUARD_ALLOW`
 * environment variables (ADR 0023).
 *
 * Runtime socket/HTTP/DNS/TLS interception has been removed in favor of
 * module-resolution `swap-or-stop` and upfront runtime stops. Scripts that
 * still pass `PYRIC_GUARD` or `PYRIC_GUARD_ALLOW` keep running without error
 * and receive one clear warning line on stderr.
 */

const DEPRECATED_GUARD_WARNED = Symbol.for('pyric.deprecatedGuardEnvWarned');

function nonEmpty(value: string | undefined): boolean {
  return (value ?? '').trim().length > 0;
}

/**
 * Emit a single deprecation line when `PYRIC_GUARD` or `PYRIC_GUARD_ALLOW` is
 * set in `env`. Returns `true` when a warning was written, `false` otherwise.
 */
export function warnDeprecatedGuardEnv(
  env: NodeJS.ProcessEnv,
  write: (line: string) => void = (line) => void process.stderr.write(line),
): boolean {
  const names: string[] = [];
  if (nonEmpty(env.PYRIC_GUARD)) names.push('PYRIC_GUARD');
  if (nonEmpty(env.PYRIC_GUARD_ALLOW)) names.push('PYRIC_GUARD_ALLOW');
  if (names.length === 0) return false;
  const label = names.join(' and ');
  const verb = names.length === 1 ? 'is' : 'are';
  write(
    `@pyric/cli: ${label} ${verb} deprecated and ignored; runtime socket interception has been removed in favor of module-level swap-or-stop.\n`,
  );
  return true;
}

/**
 * Same as {@link warnDeprecatedGuardEnv}, deduplicated per `slot` (defaults to
 * `globalThis`) so a process warns at most once across CLI and register entry
 * points.
 */
export function warnDeprecatedGuardEnvOnce(
  env: NodeJS.ProcessEnv = process.env,
  write?: (line: string) => void,
  slot: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>,
): boolean {
  if (slot[DEPRECATED_GUARD_WARNED] === true) return false;
  const warned = warnDeprecatedGuardEnv(env, write);
  if (warned) slot[DEPRECATED_GUARD_WARNED] = true;
  return warned;
}
