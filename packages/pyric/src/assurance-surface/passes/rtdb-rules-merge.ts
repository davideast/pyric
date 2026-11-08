/**
 * Non-destructive `database.rules.json` `.indexOn` merger (`mergeRtdbIndexes`)
 * and JSONC parser/sanitizer (`parseOrCloneRulesRoot`).
 */
import type { PatternSegment } from '../../sandbox/internal/resource-pattern.js';
import {
  normalizeIndexTarget,
  sanitizeWildcardName,
  type RtdbIndexRequirement,
} from './rtdb-indexes.js';

const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_FIXPOINT_PASSES = 8;

export interface MergeRtdbIndexesResult {
  readonly rules: Record<string, unknown>;
  readonly json: string;
  readonly changed: boolean;
  readonly addedCount: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function skipWhitespaceAndComments(raw: string, startIndex: number): number {
  let i = startIndex;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1;
    } else if (ch === '/' && raw[i + 1] === '/') {
      i += 2;
      while (i < raw.length && raw[i] !== '\n') i += 1;
    } else if (ch === '/' && raw[i + 1] === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i += 1;
      if (i < raw.length) i += 2;
    } else {
      break;
    }
  }
  return i;
}

function stripJsonCommentsAndTrailingCommas(raw: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < raw.length) {
        out += raw[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
    } else if (ch === '/' && raw[i + 1] === '/') {
      i += 2;
      while (i < raw.length && raw[i] !== '\n') i += 1;
    } else if (ch === '/' && raw[i + 1] === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) {
        if (raw[i] === '\n') out += '\n';
        i += 1;
      }
      if (i < raw.length) i += 2;
    } else if (ch === ',') {
      const nextCh = raw[skipWhitespaceAndComments(raw, i + 1)];
      if (nextCh !== '}' && nextCh !== ']') out += ch;
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function cloneSafeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => cloneSafeValue(item));
  if (isPlainObject(value)) return cloneSafeRuleObject(value);
  return value;
}

function cloneSafeRuleObject(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(input, key) || UNSAFE_KEYS.has(key)) continue;
    out[key] = cloneSafeValue(input[key]);
  }
  return out;
}

export function parseOrCloneRulesRoot(
  existingRulesJson: string | Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (existingRulesJson === undefined) return { rules: {} };
  let parsed: unknown = existingRulesJson;
  if (typeof existingRulesJson === 'string') {
    const trimmed = existingRulesJson.trim();
    if (trimmed.length === 0) return { rules: {} };
    parsed = JSON.parse(stripJsonCommentsAndTrailingCommas(trimmed)) as unknown;
  }
  if (!isPlainObject(parsed)) {
    throw new Error('Invalid RTDB rules JSON: expected a top-level object');
  }
  const root = cloneSafeRuleObject(parsed);
  if (!Object.hasOwn(root, 'rules')) {
    root.rules = {};
  } else if (!isPlainObject(root.rules)) {
    throw new Error('Invalid RTDB rules JSON: top-level "rules" must be an object');
  }
  return root;
}

function ensureChildObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  if (Object.hasOwn(parent, key) && isPlainObject(parent[key])) {
    return parent[key] as Record<string, unknown>;
  }
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

function mergeNodeIndexOn(node: Record<string, unknown>, requiredEntries: readonly string[]): number {
  const hasExisting = Object.hasOwn(node, '.indexOn');
  let rawExisting: unknown;
  if (hasExisting) {
    rawExisting = node['.indexOn'];
  }
  const wasArray = Array.isArray(rawExisting);

  const normalizedSet = new Set<string>();
  if (typeof rawExisting === 'string') {
    const norm = normalizeIndexTarget(rawExisting);
    if (norm.length > 0) normalizedSet.add(norm);
  } else if (Array.isArray(rawExisting)) {
    for (const item of rawExisting) {
      if (typeof item !== 'string') continue;
      const norm = normalizeIndexTarget(item);
      if (norm.length > 0) normalizedSet.add(norm);
    }
  }

  let added = 0;
  for (const req of requiredEntries) {
    const norm = normalizeIndexTarget(req);
    if (norm.length === 0 || normalizedSet.has(norm)) continue;
    normalizedSet.add(norm);
    added += 1;
  }
  if (added === 0 && hasExisting) return 0;

  const mergedSorted = [...normalizedSet].sort();
  if (mergedSorted.length === 1 && mergedSorted[0] === '.value' && !wasArray) {
    node['.indexOn'] = '.value';
  } else {
    node['.indexOn'] = mergedSorted;
  }
  return added;
}

function mergeSegmentsIntoNode(
  node: Record<string, unknown>,
  segments: readonly PatternSegment[],
  segIndex: number,
  requiredEntries: readonly string[],
): number {
  if (segIndex >= segments.length) return mergeNodeIndexOn(node, requiredEntries);

  const ownKeys = Object.keys(node).filter((k) => Object.hasOwn(node, k) && !UNSAFE_KEYS.has(k));
  const wildcardKeys = ownKeys.filter((k) => k.startsWith('$') && isPlainObject(node[k]));
  const literalChildKeys = ownKeys.filter(
    (k) => !k.startsWith('.') && !k.startsWith('$') && isPlainObject(node[k]),
  );

  const seg = segments[segIndex]!;
  if (seg.kind === 'lit') {
    if (UNSAFE_KEYS.has(seg.text) || seg.text.startsWith('.')) return 0;
    if (!Object.hasOwn(node, seg.text) && wildcardKeys.length > 0) {
      let wildcardAdded = 0;
      for (const wk of wildcardKeys) {
        wildcardAdded += mergeSegmentsIntoNode(
          ensureChildObject(node, wk),
          segments,
          segIndex + 1,
          requiredEntries,
        );
      }
      return wildcardAdded;
    }
    return mergeSegmentsIntoNode(
      ensureChildObject(node, seg.text),
      segments,
      segIndex + 1,
      requiredEntries,
    );
  }

  let added = 0;
  if (wildcardKeys.length > 0) {
    for (const wk of wildcardKeys) {
      added += mergeSegmentsIntoNode(ensureChildObject(node, wk), segments, segIndex + 1, requiredEntries);
    }
  } else {
    const wildcardKey = `$${sanitizeWildcardName(seg.name)}`;
    added += mergeSegmentsIntoNode(
      ensureChildObject(node, wildcardKey),
      segments,
      segIndex + 1,
      requiredEntries,
    );
  }
  for (const litKey of literalChildKeys) {
    added += mergeSegmentsIntoNode(ensureChildObject(node, litKey), segments, segIndex + 1, requiredEntries);
  }
  return added;
}

function compareWildcardFirst(a: RtdbIndexRequirement, b: RtdbIndexRequirement): number {
  const minLen = Math.min(a.pattern.segments.length, b.pattern.segments.length);
  for (let i = 0; i < minLen; i += 1) {
    const segA = a.pattern.segments[i]!;
    const segB = b.pattern.segments[i]!;
    if (segA.kind !== segB.kind) {
      if (segA.kind === 'var') return -1;
      if (segB.kind === 'var') return 1;
    }
    if (segA.kind === 'lit' && segB.kind === 'lit' && segA.text !== segB.text) {
      return segA.text.localeCompare(segB.text);
    }
  }
  if (a.pattern.segments.length !== b.pattern.segments.length) {
    return a.pattern.segments.length - b.pattern.segments.length;
  }
  return a.path.localeCompare(b.path);
}

export function mergeRtdbIndexes(
  existingRulesJson: string | Record<string, unknown> | undefined,
  requirements: readonly RtdbIndexRequirement[],
): MergeRtdbIndexesResult {
  const root = parseOrCloneRulesRoot(existingRulesJson);
  const rulesObj = root.rules as Record<string, unknown>;
  const ordered = requirements
    .filter((req) => req.indexOn.length > 0 && !req.pattern.segments.some((s) => s.kind === 'rest'))
    .sort(compareWildcardFirst);

  let addedCount = 0;
  for (let pass = 0; pass < MAX_FIXPOINT_PASSES; pass += 1) {
    let passAdded = 0;
    for (const req of ordered) {
      passAdded += mergeSegmentsIntoNode(rulesObj, req.pattern.segments, 0, req.indexOn);
    }
    addedCount += passAdded;
    if (passAdded === 0) break;
  }

  return {
    rules: root,
    json: `${JSON.stringify(root, null, 2)}\n`,
    changed: addedCount > 0,
    addedCount,
  };
}
