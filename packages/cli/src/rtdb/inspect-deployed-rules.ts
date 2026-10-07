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
import type { ToolHandler } from '@inbrowser/agent';
import { parseRtdbRulesText } from './rules-json.js';
import { HOSTED_CREDENTIAL_SOURCES } from '../credentials/node/scope.js';

/** The rule kinds the diff compares. */
export const DIFFED_RULE_KINDS = ['.indexOn', '.read', '.validate', '.write'] as const;
export type RtdbRuleKind = (typeof DIFFED_RULE_KINDS)[number];

/**
 * One rule expression that differs. `deployed` is absent for `added` and
 * `local` is absent for `removed`: the change is what deploying the local
 * ruleset would do to the deployed one.
 */
export interface RtdbRuleChange {
  path: string;
  kind: RtdbRuleKind;
  change: 'added' | 'removed' | 'changed';
  deployed?: string;
  local?: string;
}

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

/** Node-level diff of two `rules` trees, ordered by path then rule kind. */
export function diffRtdbRules(
  deployed: Record<string, unknown>,
  local: Record<string, unknown>,
): RtdbRuleChange[] {
  const deployedRules = collectRules(deployed);
  const localRules = collectRules(local);
  const changes: RtdbRuleChange[] = [];
  for (const key of new Set([...deployedRules.keys(), ...localRules.keys()])) {
    const d = deployedRules.get(key);
    const l = localRules.get(key);
    if (d?.value === l?.value) continue;
    const node = (d ?? l)!;
    const change: RtdbRuleChange = {
      path: node.path,
      kind: node.kind,
      change: d === undefined ? 'added' : l === undefined ? 'removed' : 'changed',
    };
    if (d !== undefined) change.deployed = d.value;
    if (l !== undefined) change.local = l.value;
    changes.push(change);
  }
  return changes.sort((a, b) => compare(a.path, b.path) || compare(a.kind, b.kind));
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface CollectedRule {
  path: string;
  kind: RtdbRuleKind;
  value: string;
}

function collectRules(root: Record<string, unknown>): Map<string, CollectedRule> {
  const out = new Map<string, CollectedRule>();
  const walk = (node: Record<string, unknown>, path: string): void => {
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('.')) {
        if ((DIFFED_RULE_KINDS as readonly string[]).includes(key)) {
          const kind = key as RtdbRuleKind;
          // A boolean and its string form are one expression: `true` and "true".
          const value = typeof child === 'string' ? child : JSON.stringify(child);
          out.set(`${path}\u0000${kind}`, { path, kind, value });
        }
      } else if (typeof child === 'object' && child !== null && !Array.isArray(child)) {
        walk(child as Record<string, unknown>, `${path === '/' ? '' : path}/${key}`);
      }
    }
  };
  walk(root, '/');
  return out;
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
