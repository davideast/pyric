/**
 * `rtdb_inspect_rules`: read the Realtime Database rules deployed to a
 * production database and diff them against the local ruleset.
 *
 * The module is read-only against production. Its only network call is one
 * `GET` of `<databaseURL>/.settings/rules.json`; it never issues `PUT`,
 * `PATCH`, `POST` or `DELETE`, never deploys, and never writes data. The
 * bearer token travels in the `Authorization` header, so it is not part of any
 * URL, and it is not returned in any result or message.
 */
import type { ToolHandler } from 'pyric/sandbox/internal';
import { diffRtdbRules, type RtdbRuleChange } from 'pyric/rules/internal/rtdb';
import { parseRtdbRulesText } from './rules-json.js';
import { HOSTED_CREDENTIAL_SOURCES } from '../credentials/node/scope.js';

// The diff itself is pure and lives in `pyric` (public from `pyric/rules`);
// it is re-exported here so this module's exports stay as they were.
export { DIFFED_RULE_KINDS, diffRtdbRules } from 'pyric/rules/internal/rtdb';
export type { DiffRtdbRulesOptions, RtdbRuleChange, RtdbRuleKind } from 'pyric/rules/internal/rtdb';

export interface InspectDeployedRtdbRulesOptions {
  scope: { resolveToken(): Promise<string> };
  databaseURL: string;
  /** Text of the local `database.rules.json`; comments are allowed. */
  localRulesText: string;
  fetchImpl?: typeof fetch;
}

export type InspectDeployedRtdbRulesResult =
  | { ok: true; deployed: { rules: Record<string, unknown> }; diff: RtdbRuleChange[] }
  | { ok: false; error: { code: string; message: string } };

const failure = (code: string, message: string): InspectDeployedRtdbRulesResult => ({
  ok: false,
  error: { code, message },
});

export async function inspectDeployedRtdbRules(
  options: InspectDeployedRtdbRulesOptions,
): Promise<InspectDeployedRtdbRulesResult> {
  let local: { rules: Record<string, unknown> };
  try {
    local = parseRtdbRulesText(options.localRulesText, (reason) => reason);
  } catch (e) {
    return failure(
      'INVALID_LOCAL_RULES',
      `The local RTDB rules are not a rules document: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const url = `${options.databaseURL.replace(/\/+$/, '')}/.settings/rules.json`;
  let response: Response;
  try {
    const token = await options.scope.resolveToken();
    response = await (options.fetchImpl ?? fetch)(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    return failure('FETCH_FAILED', `Could not read the deployed RTDB rules: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (response.status === 401 || response.status === 403) {
    const denied = response.status === 401 ? 'rejected the credentials' : 'denied the credentials access';
    return failure(
      response.status === 401 ? 'UNAUTHENTICATED' : 'PERMISSION_DENIED',
      `The database ${denied} (HTTP ${response.status}). Supply credentials through ${HOSTED_CREDENTIAL_SOURCES}, ` +
        'for a principal with the Firebase Realtime Database Viewer role (or Firebase Viewer) on the project that owns this database.',
    );
  }
  if (!response.ok) {
    return failure('FETCH_FAILED', `Reading the deployed RTDB rules failed with HTTP ${response.status}.`);
  }

  let deployed: { rules: Record<string, unknown> };
  try {
    deployed = parseRtdbRulesText(await response.text(), (reason) => reason);
  } catch (e) {
    return failure(
      'DEPLOYED_PARSE_FAILED',
      `The deployed RTDB rules are not a rules document: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return { ok: true, deployed, diff: diffRtdbRules(deployed.rules, local.rules) };
}

export interface RtdbInspectRulesToolDeps {
  scope: { resolveToken(): Promise<string> };
  databaseURL: string;
  /** Returns the text of the local `database.rules.json`. */
  readLocalRules(): string | Promise<string>;
  fetchImpl?: typeof fetch;
}

/** Library tool, the Realtime Database counterpart of `firestore_inspect_rules`. */
export function createRtdbInspectRulesTool(deps: RtdbInspectRulesToolDeps): ToolHandler {
  return {
    name: 'rtdb_inspect_rules',
    description:
      'Read the Realtime Database rules deployed to the production database with one read-only GET of .settings/rules.json, and diff them against the local database.rules.json. Returns the deployed rules and the rule expressions (.read, .write, .validate, .indexOn) added, removed or changed by path. Never writes or deploys.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const result = await inspectDeployedRtdbRules({
        scope: deps.scope,
        databaseURL: deps.databaseURL,
        localRulesText: await deps.readLocalRules(),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
      if (!result.ok) {
        return { ok: false, summary: `Inspect failed: ${result.error.message}`, data: result };
      }
      return {
        ok: true,
        summary:
          result.diff.length === 0
            ? 'The deployed RTDB rules match the local rules.'
            : `The deployed and local RTDB rules differ in ${result.diff.length} rule expression(s).`,
        data: result,
      };
    },
  };
}
