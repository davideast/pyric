/**
 * Agent-callable Rules Standard Library catalog and retained Firestore
 * compatibility aliases.
 *
 * CORE tools (always registered) because the reference is pure data
 * with no auth / no network / no sandbox state — the agent benefits
 * from it on any turn that touches rules, regardless of whether a
 * real Firebase project is signed in or diagnostics are toggled on.
 *
 * The browser-safe factory also contains local lint/module resolution for MCP
 * hosts. The Playground keeps only catalog lookups because its authoring
 * workflow resolves and validates Rules when it writes the workspace file.
 */
import type { ToolHandler } from '@inbrowser/agent';
import { createFirestoreRulesStdlibTools } from 'pyric/rules/internal';

export function buildFirestoreRulesStdlibHandlers(): ToolHandler[] {
  const catalogNames = new Set([
    'firestore_rules_stdlib_list',
    'firestore_rules_stdlib_get',
    'rules_stdlib_list',
    'rules_stdlib_get',
  ]);
  return createFirestoreRulesStdlibTools().filter((tool) =>
    catalogNames.has(tool.name),
  );
}
