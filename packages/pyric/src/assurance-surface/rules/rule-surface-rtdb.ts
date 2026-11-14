/**
 * Realtime Database `RuleSurface` normalization, projection, wildcard
 * sibling exclusion tracking, and `.validate` coverage helpers.
 */
import { parseRtdbExpressionTree, toStrictRulesJson } from '../../rules/internal/rtdb.js';
import {
  parseResourcePattern,
  type ResourcePattern,
} from '../../sandbox/internal/resource-pattern.js';
import { rtdbExpressionOwnerConditions } from './rtdb-owners.js';
import type {
  CrossServiceLookup,
  RtdbSurfaceInput,
  RtdbSurfaceSource,
  RuleSurfaceEntry,
} from './rule-surface.js';
import {
  isOverbroadAuthOnlyRtdbExpr,
  summarizeRtdbGuard,
} from './rules-ast-utils.js';
import type { OwnerCondition } from './types.js';
import { rtdbExpressionValueHints, type ValueHint } from './value-hints.js';

type RtdbWildcardExclusions = ReadonlyMap<number, ReadonlySet<string>>;
const RTDB_WILDCARD_EXCLUSIONS = new WeakMap<RuleSurfaceEntry, RtdbWildcardExclusions>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMaybeRtdbJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(toStrictRulesJson(raw));
  } catch {
    return null;
  }
}

export function normalizeRtdbSources(input: RtdbSurfaceInput | undefined): RtdbSurfaceSource[] {
  if (input === undefined) return [];
  if (typeof input === 'string') {
    return [{ source: 'database.rules.json', json: parseMaybeRtdbJson(input) }];
  }
  if (Array.isArray(input)) {
    return input.map((item) => {
      if (typeof item === 'string') {
        return { source: 'database.rules.json', json: parseMaybeRtdbJson(item) };
      }
      return {
        source: item.source ?? 'database.rules.json',
        json: parseMaybeRtdbJson(item.json),
        instance: item.instance,
      };
    });
  }
  if (Object.hasOwn(input, 'json') && (input as { json?: unknown }).json !== undefined) {
    const desc = input as RtdbSurfaceSource;
    return [
      {
        source: desc.source ?? 'database.rules.json',
        json: parseMaybeRtdbJson(desc.json),
        instance: desc.instance,
      },
    ];
  }
  const keys = Object.keys(input);
  if (
    keys.length === 1
    && keys[0] === 'rules'
    && isPlainObject((input as { rules?: unknown }).rules)
  ) {
    return [{ source: 'database.rules.json', json: input }];
  }
  const out: RtdbSurfaceSource[] = [];
  for (const [instance, raw] of Object.entries(input)) {
    out.push({
      source: `database:${instance}.rules.json`,
      json: parseMaybeRtdbJson(raw),
      instance,
    });
  }
  return out;
}

function parseDeclaredIndexes(raw: unknown): string[] | undefined {
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === 'string');
  }
  return undefined;
}

function dedupeValueHints(hints: readonly ValueHint[]): ValueHint[] {
  const seen = new Set<string>();
  const out: ValueHint[] = [];
  for (const h of hints) {
    const key = `${h.service}|${h.path}|${h.field}|${typeof h.value}:${String(h.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

export function projectRtdbSource(item: RtdbSurfaceSource): RuleSurfaceEntry[] {
  const file = item.source ?? 'database.rules.json';
  let root: unknown;
  if (isPlainObject(item.json)) root = item.json.rules;
  if (!isPlainObject(root)) return [];
  const out: RuleSurfaceEntry[] = [];

  const walk = (
    node: Record<string, unknown>,
    path: readonly string[],
    exclusions: RtdbWildcardExclusions,
  ): void => {
    const rawPath = path.join('/');
    const pattern = parseResourcePattern('rtdb', rawPath, item.instance);
    let rawIndexOn: unknown;
    if (Object.hasOwn(node, '.indexOn')) rawIndexOn = node['.indexOn'];
    const declaredIndexes = parseDeclaredIndexes(rawIndexOn);

    let validateHints: ValueHint[] = [];
    if (Object.hasOwn(node, '.validate') && typeof node['.validate'] === 'string') {
      const parsedVal = parseRtdbExpressionTree(node['.validate']);
      if (parsedVal.ok) {
        validateHints = rtdbExpressionValueHints(parsedVal.tree, rawPath);
      }
    }

    let emittedRuleOnNode = false;
    for (const [ruleKey, opName] of [
      ['.read', 'read'],
      ['.write', 'write'],
      ['.validate', 'validate'],
    ] as const) {
      if (!Object.hasOwn(node, ruleKey)) continue;
      const exprText = node[ruleKey];
      if (typeof exprText !== 'string' && typeof exprText !== 'boolean') continue;
      const normalizedExpr = String(exprText);
      const parsed = parseRtdbExpressionTree(normalizedExpr);
      const entrySource = `${file}#/rules/${[...path, ruleKey].join('/')}`;
      let ownerConditions: OwnerCondition[] = [];
      let valueHints: ValueHint[] = [];
      let overbroad: boolean | undefined;
      let alwaysDeny: boolean | undefined;

      if (parsed.ok) {
        if (summarizeRtdbGuard(parsed.tree, false) === 'impossible') {
          alwaysDeny = true;
        }
        ownerConditions = rtdbExpressionOwnerConditions(parsed.tree, path, opName, entrySource);
        if (opName === 'write') {
          valueHints = dedupeValueHints([
            ...rtdbExpressionValueHints(parsed.tree, rawPath),
            ...validateHints,
          ]);
          overbroad = isOverbroadAuthOnlyRtdbExpr(parsed.tree);
        } else if (opName === 'validate') {
          valueHints = validateHints;
        }
      } else if (opName === 'write') {
        overbroad = false;
      }

      const entry: {
        pattern: ResourcePattern;
        ops: readonly string[];
        ownerConditions: readonly OwnerCondition[];
        valueHints: readonly ValueHint[];
        declaredIndexes?: readonly string[];
        crossServiceReads: readonly CrossServiceLookup[];
        overbroadAuthOnlyWrite?: boolean;
        alwaysDeny?: boolean;
        source: string;
      } = {
        pattern,
        ops: [opName],
        ownerConditions,
        valueHints,
        crossServiceReads: [],
        source: entrySource,
      };
      if (declaredIndexes !== undefined) entry.declaredIndexes = declaredIndexes;
      if (overbroad !== undefined) entry.overbroadAuthOnlyWrite = overbroad;
      if (alwaysDeny !== undefined) entry.alwaysDeny = alwaysDeny;
      if (exclusions.size > 0) RTDB_WILDCARD_EXCLUSIONS.set(entry, exclusions);
      out.push(entry);
      emittedRuleOnNode = true;
    }

    if (!emittedRuleOnNode && declaredIndexes !== undefined) {
      const indexEntry: RuleSurfaceEntry = {
        pattern,
        ops: [],
        ownerConditions: [],
        valueHints: [],
        declaredIndexes,
        crossServiceReads: [],
        source: `${file}#/rules/${[...path, '.indexOn'].join('/')}`,
      };
      if (exclusions.size > 0) RTDB_WILDCARD_EXCLUSIONS.set(indexEntry, exclusions);
      out.push(indexEntry);
    }

    const literalChildren = new Set<string>();
    for (const [key, value] of Object.entries(node)) {
      if (!key.startsWith('.') && !key.startsWith('$') && isPlainObject(value)) {
        literalChildren.add(key);
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (!key.startsWith('.') && isPlainObject(value)) {
        let childExclusions = exclusions;
        if (key.startsWith('$') && literalChildren.size > 0) {
          const next = new Map(exclusions);
          next.set(path.length, literalChildren);
          childExclusions = next;
        }
        walk(value, [...path, key], childExclusions);
      }
    }
  };

  walk(root, [], new Map());
  return out;
}

export function violatesRtdbWildcardExclusions(
  entry: RuleSurfaceEntry,
  pattern: ResourcePattern,
): boolean {
  const exclusions = RTDB_WILDCARD_EXCLUSIONS.get(entry);
  if (!exclusions || pattern.service !== 'rtdb') return false;
  for (const [segIndex, excludedLiterals] of exclusions) {
    const seg = pattern.segments[segIndex];
    if (!seg) break;
    if (seg.kind === 'lit' && excludedLiterals.has(seg.text)) {
      return true;
    }
    if (seg.kind === 'rest') break;
  }
  return false;
}

export function rtdbValidateCoversTarget(
  validateEntry: RuleSurfaceEntry,
  target: ResourcePattern,
): boolean {
  if (validateEntry.pattern.service !== 'rtdb' || target.service !== 'rtdb') return false;
  if (validateEntry.pattern.resourceId !== target.resourceId) return false;
  const valSegs = validateEntry.pattern.segments;
  const targetSegs = target.segments;
  if (valSegs.length > targetSegs.length) return false;
  const exclusions = RTDB_WILDCARD_EXCLUSIONS.get(validateEntry);
  for (let i = 0; i < valSegs.length; i += 1) {
    const vSeg = valSegs[i]!;
    const tSeg = targetSegs[i]!;
    if (vSeg.kind === 'lit') {
      if (tSeg.kind !== 'lit' || tSeg.text !== vSeg.text) return false;
      continue;
    }
    if (vSeg.kind === 'var') {
      const excluded = exclusions?.get(i);
      if (tSeg.kind === 'lit') {
        if (excluded?.has(tSeg.text)) return false;
        continue;
      }
      if (tSeg.kind === 'var') {
        if (excluded && excluded.size > 0) return false;
        continue;
      }
      return false;
    }
    return false;
  }
  return true;
}
