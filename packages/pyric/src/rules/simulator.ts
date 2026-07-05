/**
 * Browser-safe entry for the simulator tool factory.
 *
 * Consumers building MCP / agent tool surfaces that run in a browser
 * (e.g. `@pyric/dev`'s in-page bridge client) import from here:
 *
 * ```ts
 * import { createFirestoreSimulatorTools } from '@pyric/firestore-rules/simulator';
 * const tools = createFirestoreSimulatorTools({ resolveSandbox });
 * ```
 *
 * The factory wires the browser-safe `resolveModulesBrowser` so
 * `firestore_simulator_create` accepts `rules_version = '2+modules'`
 * sources without a disk dependency.
 *
 * The Node entry (`@pyric/firestore-rules/node`) re-exports the same
 * factory wired with the disk-reading `resolveModules`. The two
 * factories share `./simulator-tools-impl.ts` — drift between
 * browser dispatch and Node MCP advertisement is impossible by
 * construction.
 */

import { resolveModulesBrowser } from './modules/resolver-browser.js';
import {
  createFirestoreSimulatorTools as createFirestoreSimulatorToolsImpl,
  type FirestoreSimulatorToolDeps as FirestoreSimulatorToolDepsImpl,
} from './simulator-tools-impl.js';
import type { ToolHandler } from '@inbrowser/agent';

export type FirestoreSimulatorToolDeps = Pick<
  FirestoreSimulatorToolDepsImpl,
  'resolveSandbox'
>;

export function createFirestoreSimulatorTools(
  deps: FirestoreSimulatorToolDeps,
): ToolHandler[] {
  return createFirestoreSimulatorToolsImpl({
    resolveSandbox: deps.resolveSandbox,
    resolveModulesFn: resolveModulesBrowser,
  });
}
