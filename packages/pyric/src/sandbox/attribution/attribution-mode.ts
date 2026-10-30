/**
 * The switch that decides whether listener attribution runs.
 *
 * Attribution is a development diagnostic: it constructs one `Error` per
 * listener attach to read a stack, and installs one `MutationObserver` around
 * each snapshot callback. Neither cost belongs in a production build, and
 * neither result has a consumer there, so attribution is off whenever the
 * environment says production.
 *
 * The production signal is `process.env.NODE_ENV === 'production'`, written
 * as that literal expression so it works in both runtimes the mirror runs in:
 *
 * - A browser bundler substitutes the expression at build time (Vite, webpack
 *   and Next.js all replace `process.env.NODE_ENV`), so a shipped bundle
 *   reads `'production'` even though no `process` exists there.
 * - In Node, it is the marker the rest of this repository already treats as
 *   "this is production" (the CLI's Next.js passthrough guard and the
 *   `@pyric/cli/register` refusal both read it).
 *
 * This module never reads `import.meta.env`. The Vite dev server prepends the
 * whole `import.meta.env` object, every `VITE_`-prefixed variable included, to
 * any module that reads any property of it, so a read here would serve those
 * values to every page whether or not the app reads them (#1632).
 *
 * A caller that wants attribution regardless of the signal turns it on
 * explicitly through {@link configureListenerAttribution}, which overrides
 * it. That is the "explicit option" path: a production-mode test harness, or
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
 * `true` when the bundler stamped this build as production, or the host
 * process declares itself production. Read inside a try/catch because an
 * unbundled browser page or worker has no `process`, and the bare reference
 * throws there.
 */
function isProduction(): boolean {
  try {
    return process.env.NODE_ENV === PRODUCTION_ENVIRONMENT;
  } catch {
    return false;
  }
}

/** Whether listener attribution should run right now. */
export function listenerAttributionEnabled(): boolean {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return !isProduction();
}
