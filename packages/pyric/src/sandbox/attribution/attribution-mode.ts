/**
 * The switch that decides whether listener attribution runs.
 *
 * Attribution is a development diagnostic: it constructs one `Error` per
 * listener attach to read a stack, and installs one `MutationObserver` around
 * each snapshot callback. Neither cost belongs in a production build, and
 * neither result has a consumer there, so attribution is off whenever the
 * environment says production.
 *
 * Two production signals are read, in this order, because the mirror runs in
 * two runtimes:
 *
 * 1. `import.meta.env.PROD`, which a browser bundler substitutes at build
 *    time. This is the signal that survives into a shipped bundle, where no
 *    `process` exists.
 * 2. `process.env.NODE_ENV === 'production'`, the marker the rest of this
 *    repository already treats as "this is production" (the CLI's Next.js
 *    passthrough guard and the `@pyric/cli/register` refusal both read it).
 *
 * A caller that wants attribution regardless of either signal turns it on
 * explicitly through {@link configureListenerAttribution}, which overrides
 * both. That is the "explicit option" path: a production-mode test harness, or
 * a host that wants attribution in a build the bundler marked production.
 */

const PRODUCTION_ENVIRONMENT = 'production';

/**
 * How the switch decides. `'auto'` reads the environment; `'on'` and `'off'`
 * are explicit caller overrides that ignore it.
 */
export type ListenerAttributionMode = 'auto' | 'on' | 'off';

let mode: ListenerAttributionMode = 'auto';

/** Override the environment decision. Pass `'auto'` to hand it back. */
export function configureListenerAttribution(next: ListenerAttributionMode): void {
  mode = next;
}

/** The override currently in force. `'auto'` means the environment decides. */
export function listenerAttributionMode(): ListenerAttributionMode {
  return mode;
}

/**
 * `true` when the bundler stamped this build as production. Read through a
 * cast and a try/catch because `import.meta.env` exists only under a bundler,
 * and a plain Node ESM runtime leaves it undefined.
 */
function isBundledProduction(): boolean {
  try {
    const env = (import.meta as { env?: { PROD?: boolean } }).env;
    return env?.PROD === true;
  } catch {
    return false;
  }
}

/** `true` when the host process declares itself production. */
function isProcessProduction(): boolean {
  const runtime = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  if (runtime === undefined) return false;
  return runtime.env?.NODE_ENV === PRODUCTION_ENVIRONMENT;
}

/** Whether listener attribution should run right now. */
export function listenerAttributionEnabled(): boolean {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  if (isBundledProduction()) return false;
  if (isProcessProduction()) return false;
  return true;
}
