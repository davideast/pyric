/**
 * Rule-by-rule diff of two RTDB `rules` trees.
 *
 * Pure: no I/O. `rtdb_inspect_rules` in `@pyric/cli` diffs the deployed rules
 * against the local ruleset with it, and `pyric/rules` exports it so a project
 * can compare two rulesets itself, such as hand-written rules against the
 * rules a constraints definition compiles to.
 */
import { canonicalRtdbExpression } from './grammar/canonical.js';
import type { RtdbRuleKind } from './source-locations.js';

export type { RtdbRuleKind } from './source-locations.js';

/** The rule kinds the diff compares. */
export const DIFFED_RULE_KINDS = ['.indexOn', '.read', '.validate', '.write'] as const satisfies readonly RtdbRuleKind[];

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

export interface DiffRtdbRulesOptions {
  /**
   * Treat two `.read`, `.write` or `.validate` expressions as the same rule
   * when their {@link canonicalRtdbExpression} texts are equal: spellings
   * that cannot change any decision, such as `===` for `==` or
   * `child('a/' + $id)` for `child('a').child($id)`. A changed entry still
   * reports both expressions as written. An expression that does not parse
   * is compared as written. Default `false`: expressions compare as text.
   */
  ignoreEquivalent?: boolean;
}

/** Node-level diff of two `rules` trees, ordered by path then rule kind. */
export function diffRtdbRules(
  deployed: Record<string, unknown>,
  local: Record<string, unknown>,
  options: DiffRtdbRulesOptions = {},
): RtdbRuleChange[] {
  const deployedRules = collectRules(deployed);
  const localRules = collectRules(local);
  const changes: RtdbRuleChange[] = [];
  for (const key of new Set([...deployedRules.keys(), ...localRules.keys()])) {
    const d = deployedRules.get(key);
    const l = localRules.get(key);
    if (d?.value === l?.value) continue;
    if (options.ignoreEquivalent === true && d !== undefined && l !== undefined && equivalentRules(d, l)) continue;
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

/** Whether two rule expressions at one path and kind have equal canonical texts. */
function equivalentRules(a: CollectedRule, b: CollectedRule): boolean {
  if (a.kind === '.indexOn') return false;
  const ca = canonicalOrUndefined(a.value);
  return ca !== undefined && ca === canonicalOrUndefined(b.value);
}

function canonicalOrUndefined(raw: string): string | undefined {
  try {
    return canonicalRtdbExpression(raw);
  } catch {
    return undefined;
  }
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface CollectedRule {
  path: string;
  kind: RtdbRuleKind;
  value: string;
}

function formatRuleValue(kind: RtdbRuleKind, value: unknown): string {
  if (kind === '.indexOn') {
    const normalized = typeof value === 'string' ? [value] : value;
    return JSON.stringify(normalized);
  }
  // A boolean and its string form are one expression: `true` and "true".
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function collectRules(root: Record<string, unknown>): Map<string, CollectedRule> {
  const out = new Map<string, CollectedRule>();
  const walk = (node: Record<string, unknown>, path: string): void => {
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('.')) {
        if ((DIFFED_RULE_KINDS as readonly string[]).includes(key)) {
          const kind = key as RtdbRuleKind;
          const value = formatRuleValue(kind, child);
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
