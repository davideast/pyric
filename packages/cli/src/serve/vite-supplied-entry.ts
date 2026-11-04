/**
 * `@pyric/cli/vite/internal/supplied-rows`: the one seam through which
 * `@pyric/live` serves its rows on the Vite page plane, over this package's
 * plugin, Node host and swap table. It takes no module ids: the row modules
 * are fixed (`vite-supplied-rows.ts`), and their source comes from the
 * `@pyric/live` installed in the project, so without that package the plugin
 * refuses to start and the stop stays shut. `pyric()` never reads it, and no
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
export type { ObservedCall, ObservedCallService, ProductionOutcome } from 'pyric/sandbox';

/** What the supplier gives: only the error for a refused import. */
export interface SuppliedRowsInput {
  readonly refusal: SuppliedRowsRefusal;
}

/** The plugin `pyric(options)` builds, with the live rows serving pages in place of the swap. */
export function pyricWithSuppliedRows(options: PyricOptions, input: SuppliedRowsInput): Plugin & EnvironmentHooks {
  return createPyricPlugin(options, suppliedRows(input.refusal));
}

/**
 * The project the live host on a dev server rooted at `viteRoot` names: the
 * one the generation reports in `/__pyric/health`, resolved as the
 * `pyric-live` command and the register resolve it.
 */
export function liveProjectFor(viteRoot: string, options: Pick<PyricOptions, 'root' | 'project'>): string {
  return liveProjectId(resolveFirebaseProjectDir(viteRoot, options.root), options.project);
}
