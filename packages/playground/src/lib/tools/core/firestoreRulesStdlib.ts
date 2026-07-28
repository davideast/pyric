/**
 * Agent-callable Rules Standard Library catalog, resolver, and retained
 * Firestore compatibility aliases.
 *
 * CORE tools (always registered) because the reference is pure data
 * with no auth / no network / no sandbox state — the agent benefits
 * from it on any turn that touches rules, regardless of whether a
 * real Firebase project is signed in or diagnostics are toggled on.
 *
 * The browser-safe factory includes the catalog, local lint/module resolution,
 * and the service-neutral Rules variants. Simulation and hosted testing live
 * on the Node-only rules factory and are not registered here.
 */
import type { ToolHandler } from '@inbrowser/agent';
import { createFirestoreRulesStdlibTools } from 'pyric/rules/internal';

export function buildFirestoreRulesStdlibHandlers(): ToolHandler[] {
  return createFirestoreRulesStdlibTools();
}
