/**
 * Browser-safe `firestore_inspect_rules` factory. Returns a single
 * `ToolHandler` that, given a `ProjectScope`, fetches + parses the
 * currently deployed Firestore ruleset.
 *
 * Split from the main `createFirestoreRulesTools` factory (which is
 * Node-only — it wraps the disk-reading modules resolver) so browser
 * callers (the playground, debug surfaces) can opt into just the
 * inspect tool without dragging in `node:fs`.
 *
 * Server-side callers should use `createFirestoreRulesTools({ scope })`
 * (Node entry) which includes this tool + the rest of the rules
 * lifecycle (test, simulate, lint, resolve-modules).
 */
import type { ToolHandler } from '@inbrowser/agent';
import type { ProjectScope } from 'pyric-tools/deploy';
import { InspectFirestoreRulesHandler } from './handler.js';

export interface FirestoreInspectToolDeps {
  scope: ProjectScope;
}

export function createFirestoreInspectTool(deps: FirestoreInspectToolDeps): ToolHandler {
  const { scope } = deps;
  const handler = new InspectFirestoreRulesHandler();
  return {
    name: 'firestore_inspect_rules',
    description:
      'Fetch and parse the currently deployed Firestore security rules for this project. Returns the parsed AST with match blocks, functions, allow rules, and a summary including public paths, operation counts, and function names. Use this to understand the security model before generating code or modifying rules.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const result = await handler.execute(scope);
      return {
        ok: result.success,
        summary: result.success
          ? `${result.data.summary.totalAllowRules} allow rule(s) across ${result.data.summary.matchPaths.length} match path(s)`
          : `Inspect failed: ${result.error.message}`,
        data: result,
      };
    },
  };
}
