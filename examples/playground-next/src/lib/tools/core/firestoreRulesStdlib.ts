/**
 * `firestore_rules_stdlib_list` + `firestore_rules_stdlib_get` —
 * agent-callable reference for the Firestore Rules standard library.
 *
 * CORE tools (always registered) because the reference is pure data
 * with no auth / no network / no sandbox state — the agent benefits
 * from it on any turn that touches rules, regardless of whether a
 * real Firebase project is signed in or diagnostics are toggled on.
 *
 * Wraps the `createFirestoreRulesTools()` factory from
 * `@pyric/firestore-rules` and picks out just the two stdlib tools.
 * The other tools in that factory (lint, resolve-modules, simulate,
 * test) are intentionally not registered here — lint runs as a
 * diagnostic block automatically, simulate isn't exposed in the
 * playground today, and test needs a ProjectScope it doesn't have
 * here.
 */
import type { ToolHandler } from '@inbrowser/agent';
import { createFirestoreRulesStdlibTools } from 'pyric/rules';

export function buildFirestoreRulesStdlibHandlers(): ToolHandler[] {
  return createFirestoreRulesStdlibTools();
}
