/**
 * `firestore_get_rules` wired against the user's signed-in Firebase
 * project. This is intentionally read-only; production changes are owned by
 * the Firebase CLI.
 *
 * Browser-safe — uses `@pyric/firestore-rules`'
 * `createFirestoreInspectTool({ scope })` factory to get a single
 * ToolHandler whose handler hits
 * `firebaserules.googleapis.com/v1/projects/{id}/rulesets` (list + get
 * latest). The scope's `resolveToken` returns the user's signed-in
 * access token. Permission needed: `firebaserules.releases.get`,
 * covered by the playground's existing `auth/firebase` scope — no new
 * consent.
 *
 * Results are returned IN-TURN only — nothing is cached or persisted.
 * The agent re-calls the tool when it needs the deployed ruleset again.
 *
 * Registration gate: same as `firestore-discover.ts` — only built
 * when signed in, project picked, and `pyricDiagnosticsEnabled` is
 * true (the last gate handled by the caller in `~/lib/tools/index.ts`).
 */
import { createFirestoreInspectTool } from 'pyric/rules/internal';
import type { ToolHandler } from '@inbrowser/agent';

export interface RulesInspectHandlerOptions {
  accessToken: string;
  projectId: string;
}

export function buildFirestoreRulesInspectHandler(
  opts: RulesInspectHandlerOptions,
): ToolHandler {
  return createFirestoreInspectTool({
    scope: {
      projectId: opts.projectId,
      resolveToken: async () => opts.accessToken,
    },
  });
}
