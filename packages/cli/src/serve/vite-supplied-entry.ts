/**
 * `@pyric/cli/vite/internal/supplied-rows`: the one seam through which
 * another workspace package serves its own Firebase rows on the Vite page
 * plane, over this package's plugin, Node host and swap table. Not a public
 * entry: `pyric()` never reads it, and no option, flag or environment
 * variable reaches it.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';
import { createViteModuleContext } from './vite-module-swap.js';
import { createPyricPlugin, type EnvironmentHooks, type PyricOptions } from './vite-plugin.js';
import { suppliedRows, type SuppliedRows } from './vite-supplied-rows.js';

export { SDK_MODULES, swappedFirebaseEntries } from './firebase-module-swap.js';
export type { FirebaseRowSet, ServedFirebaseSpecifier } from './firebase-module-swap.js';
export { INSTALLED_SDK_SPECIFIERS } from './vite-supplied-rows.js';
export type { SuppliedRows, SuppliedRowsPlane } from './vite-supplied-rows.js';
export type { PyricOptions } from './vite-plugin.js';
export type { ObservedCall, ObservedCallService, ProductionOutcome } from 'pyric/sandbox';

/** The plugin `pyric(options)` builds, with `rows` serving pages in place of the swap. */
export function pyricWithSuppliedRows(options: PyricOptions, rows: SuppliedRows): Plugin & EnvironmentHooks {
  return createPyricPlugin(options, suppliedRows(rows));
}

/**
 * The file a supplied row's page module imports `sendObservedCall` from. It
 * sits beside the served entries, so it shares the page runtime's connection.
 */
export function observedCallSenderEntry(): string {
  const entriesDir = dirname(createViteModuleContext().entries.init);
  const js = join(entriesDir, 'observed-call-sender.js');
  return existsSync(js) ? js : join(entriesDir, 'observed-call-sender.ts');
}
