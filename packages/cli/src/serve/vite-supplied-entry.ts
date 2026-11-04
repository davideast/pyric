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
import { createPyricPlugin, type EnvironmentHooks, type PyricOptions } from './vite-plugin.js';
import { suppliedRows, type SuppliedRowsRefusal } from './vite-supplied-rows.js';

export { SDK_MODULES, swappedFirebaseEntries } from './firebase-module-swap.js';
export type { FirebaseRowSet, ServedFirebaseSpecifier } from './firebase-module-swap.js';
export { INSTALLED_SDK_SPECIFIERS, OBSERVER_MODULE_ID, OBSERVER_SPECIFIER, ROW_MODULE_IDS } from './vite-supplied-rows.js';
export type { SuppliedRowsPlane, SuppliedRowsRefusal } from './vite-supplied-rows.js';
export type { PyricOptions } from './vite-plugin.js';
export type { PyricWrite, PyricWriter, PyricWriteRefusal } from './hosted/own-writes.js';
export type { ObservedCall, ObservedCallService, ProductionOutcome } from 'pyric/sandbox';

/** What the supplier gives: only the error for a refused import. */
export interface SuppliedRowsInput {
  readonly refusal: SuppliedRowsRefusal;
}

/** The plugin `pyric(options)` builds, with the live rows serving pages in place of the swap. */
export function pyricWithSuppliedRows(options: PyricOptions, input: SuppliedRowsInput): Plugin & EnvironmentHooks {
  return createPyricPlugin(options, suppliedRows(input.refusal));
}
