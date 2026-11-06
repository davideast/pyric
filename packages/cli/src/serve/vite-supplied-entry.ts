/**
 * `@pyric/cli/vite/internal/supplied-rows`: the one seam through which
 * `@pyric/live` serves its rows on the Vite page plane, over this package's
 * plugin, Node host and swap table. It takes no module ids: the row modules
 * are fixed (`vite-supplied-rows.ts`), and their source comes from the
 * `@pyric/live` installed in the project, so without that package the plugin
 * refuses to start and the stop stays shut. The host the plugin runs takes
 * its refusal of pyric's own writes from that package too, so it is in live
 * mode exactly when the rows are. `pyric()` never reads it, and no
 * option, flag or environment variable reaches it.
 */
import type { Plugin } from 'vite';
import { createPyricPlugin, resolveFirebaseProjectDir, type EnvironmentHooks, type PyricOptions } from './vite-plugin.js';
import { liveProjectId } from './live-project.js';
import { suppliedRows, type SuppliedRowsRefusal } from './vite-supplied-rows.js';

export { SDK_MODULES, swappedFirebaseEntries } from './firebase-module-swap.js';
export type { FirebaseRowSet, ServedFirebaseSpecifier } from './firebase-module-swap.js';
export { INSTALLED_SDK_SPECIFIERS, OBSERVER_MODULE_ID, OBSERVER_SPECIFIER, ROW_MODULE_IDS } from './vite-supplied-rows.js';
export type { SuppliedRowsPlane, SuppliedRowsRefusal } from './vite-supplied-rows.js';
export type { PyricOptions } from './vite-plugin.js';
export type { PyricWrite, PyricWriter, PyricWriteRefusal } from './hosted/own-writes.js';
export type { LiveListener, LiveListenerActivity } from './entries/live-listener-journal.js';
export type { ObservedCall, ObservedCallService, ProductionOutcome } from 'pyric/sandbox';
export { livePassThroughLine } from 'pyric/sandbox/internal';

/** What the supplier gives: the error for a refused import, where it is installed, and the served specifiers it passes through. */
export interface SuppliedRowsInput {
  readonly refusal: SuppliedRowsRefusal;
  /**
   * The folder of the `@pyric/live` package calling this seam. The rows'
   * source comes from the `@pyric/live` that resolves from there, before the
   * one the project root resolves, so the rows open when that package is
   * installed beside the app rather than in it.
   */
  readonly liveRoot?: string;
  /**
   * Served specifiers with no live row that load the installed SDK unwrapped
   * and unobserved (`vite-supplied-rows.ts`). Any other entry throws.
   */
  readonly passThrough?: readonly string[];
}

/** The plugin `pyric(options)` builds, with the live rows serving pages in place of the swap. */
export function pyricWithSuppliedRows(options: PyricOptions, input: SuppliedRowsInput): Plugin & EnvironmentHooks {
  return createPyricPlugin(options, suppliedRows(input.refusal, { liveRoot: input.liveRoot, passThrough: input.passThrough }));
}

/**
 * The project the live host on a dev server rooted at `viteRoot` names: the
 * one the generation reports in `/__pyric/health`, resolved as the
 * `pyric-live` command and the register resolve it.
 */
export function liveProjectFor(viteRoot: string, options: Pick<PyricOptions, 'root' | 'project'>): string {
  return liveProjectId(resolveFirebaseProjectDir(viteRoot, options.root), options.project);
}
