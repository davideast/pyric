/**
 * Browser-safe entry for the simulator tool factory.
 *
 * Hosts building MCP / agent tool surfaces that run in a browser can bundle
 * this source entry to avoid pulling the Node-only resolver into the browser.
 *
 * The factory wires the browser-safe `resolveModulesBrowser` so
 * `firestore_simulator_create` accepts `rules_version = '2+modules'`
 * sources without a disk dependency.
 *
 * The public Node entry (`pyric/rules/node`) re-exports the same factory wired
 * with the disk-reading `resolveModules`. The two factories share
 * `./simulator-tools-impl.ts` so browser dispatch and Node MCP advertisement
 * stay in lockstep.
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
