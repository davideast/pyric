import {
  collectRtdbRuleAncestors,
  normalizeNode,
  parseRtdbExpressionTree,
  type CompiledRtdbRules,
  type RtdbExpressionTree,
  type RtdbNode,
} from 'pyric/rules/internal/rtdb';
import type { ObservedRtdbLookup } from '../../observed-session/coverage.js';
import { canonicalRtdbPath, rtdbPathSegments } from '../../observed-session/rtdb-tree.js';
import {
  defineOwnField,
  isPlainRecord,
  unionOf,
  type Gap,
  type Given,
} from './observe-local-evaluation.js';

export interface RtdbExpressionAccess {
  readsAuthToken: boolean;
  readsAuthEmail: boolean;
  readsQuery: boolean;
  readsNewData: boolean;
}

type RtdbChain =
  | { root: 'auth'; path: Array<string | '*'> }
  | { root: 'query' }
  | { root: 'newData' }
  | undefined;

function noteAuthChain(access: RtdbExpressionAccess, path: readonly (string | '*')[]): void {
  const first = path[0];
  if (first !== 'token' && first !== '*') return;
  access.readsAuthToken = true;
  const second = path[1];
  if (first === '*' && second !== undefined) {
    if (second === 'email' || second === 'firebase' || second === '*') {
      access.readsAuthEmail = true;
    }
    return;
  }
  if (second === 'email' || second === '*') {
    access.readsAuthEmail = true;
    return;
  }
  if (second === 'firebase') {
    const third = path[2];
    if (third === 'identities' || third === '*') {
      access.readsAuthEmail = true;
    }
  }
}

export function analyzeRtdbExpression(raw: string): RtdbExpressionAccess {
  const parsed = parseRtdbExpressionTree(raw);
  if (!parsed.ok) {
    return {
      readsAuthToken: /\bauth\b[\s)]*(?:\.\s*token\b|\[\s*['"]token['"]\s*\])/.test(raw),
      readsAuthEmail:
        /\bauth\b[\s)]*(?:\.\s*token|\[\s*['"]token['"]\s*\])[\s)]*(?:\.\s*email\b|\[\s*['"]email['"]\s*\]|(?:\.\s*firebase|\[\s*['"]firebase['"]\s*\])[\s)]*(?:\.\s*identities\b|\[\s*['"]identities['"]\s*\]))/.test(
          raw,
        ),
      readsQuery: /(?<![\w.$])query\b/.test(raw),
      readsNewData: /(?<![\w.$])newData\b/.test(raw),
    };
  }
  const access: RtdbExpressionAccess = {
    readsAuthToken: false,
    readsAuthEmail: false,
    readsQuery: false,
    readsNewData: false,
  };
  const walk = (node: RtdbExpressionTree): RtdbChain => {
    switch (node.type) {
      case 'identifier':
        if (node.name === 'auth') return { root: 'auth', path: [] };
        if (node.name === 'query') return { root: 'query' };
        if (node.name === 'newData') {
          access.readsNewData = true;
          return { root: 'newData' };
        }
        return undefined;
      case 'member': {
        const base = walk(node.object);
        if (base?.root === 'auth') {
          const path = [...base.path, node.property];
          noteAuthChain(access, path);
          return { root: 'auth', path };
        }
        if (base?.root === 'query') {
          access.readsQuery = true;
          return { root: 'query' };
        }
        return undefined;
      }
      case 'index': {
        const base = walk(node.object);
        walk(node.index);
        const key: string | '*' = node.index.type === 'string' ? node.index.value : '*';
        if (base?.root === 'auth') {
          const path = [...base.path, key];
          noteAuthChain(access, path);
          return { root: 'auth', path };
        }
        if (base?.root === 'query') {
          access.readsQuery = true;
          return { root: 'query' };
        }
        return undefined;
      }
      case 'call': {
        const recv = walk(node.receiver);
        for (const arg of node.args) walk(arg);
        if (recv?.root === 'query') access.readsQuery = true;
        return undefined;
      }
      case 'ternary':
        walk(node.test);
        walk(node.consequent);
        walk(node.alternate);
        return undefined;
      case 'binary':
        walk(node.left);
        walk(node.right);
        return undefined;
      case 'unary':
        walk(node.argument);
        return undefined;
      case 'array':
        for (const el of node.elements) walk(el);
        return undefined;
      case 'string':
      case 'number':
      case 'regex':
      case 'boolean':
      case 'null':
        return undefined;
    }
  };
  walk(parsed.tree);
  return access;
}

export function rtdbExpressionGaps(expressions: readonly string[], given: Given): Gap[] {
  const gaps: Gap[] = [];
  for (const expr of expressions) {
    const access = analyzeRtdbExpression(expr);
    if (access.readsAuthToken && !given.claims) gaps.push('claim-values');
    if (access.readsAuthEmail && !given.emailKnown) gaps.push('claim-values');
    if (access.readsQuery) gaps.push('query');
  }
  return unionOf(gaps, []);
}

/**
 * True when a captured RTDB write value normalizes to `null` (`null`, `{}`, `[]`,
 * nested all-null subtrees, or priority-only objects without `.value`).
 * Returns `false` for `undefined`, which denotes an uncaptured write payload.
 */
export function isNullRtdbWrite(value: unknown): boolean {
  if (value === undefined) return false;
  return normalizeNode(value) === null;
}

export function hasCapturedRtdbPriority(value: unknown): boolean {
  if (!isPlainRecord(value) || !Object.hasOwn(value, '.priority')) return false;
  const priority = value['.priority'];
  return (
    priority === null ||
    typeof priority === 'string' ||
    typeof priority === 'number' ||
    (isPlainRecord(priority) && Object.hasOwn(priority, '.sv'))
  );
}

export function scrubRtdbWriteValue(
  value: unknown,
  now: number,
  state: { hasIncrement: boolean },
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => scrubRtdbWriteValue(item, now, state));
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, '.sv')) {
    const sv = record['.sv'];
    if (sv === 'timestamp') return now;
    if (isPlainRecord(sv) && 'increment' in sv) {
      state.hasIncrement = true;
      return 0;
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    defineOwnField(out, k, scrubRtdbWriteValue(v, now, state));
  }
  return out;
}

function collectDescendantValidates(node: RtdbNode, out: string[]): void {
  if (node.validate !== undefined) out.push(node.validate.raw);
  for (const child of node.children) collectDescendantValidates(child, out);
}

export function unwrittenValidates(compiled: CompiledRtdbRules, target: string, allowed: boolean): string[] {
  const segments = rtdbPathSegments(target);
  const steps = collectRtdbRuleAncestors(compiled, segments);
  const validates = steps
    .map((step) => step.node.validate?.raw)
    .filter((raw): raw is string => raw !== undefined);
  const deepest = steps[steps.length - 1];
  const reachesTarget = allowed && steps.length === segments.length + 1 && deepest !== undefined;
  if (reachesTarget) {
    for (const child of deepest.node.children) collectDescendantValidates(child, validates);
  }
  return validates;
}

export function uncapturedAncestorValidatePaths(
  compiled: CompiledRtdbRules,
  target: string,
  lookup: ObservedRtdbLookup,
): string[] {
  const targetSegments = rtdbPathSegments(target);
  const targetDepth = targetSegments.length;
  const missing: string[] = [];
  for (const step of collectRtdbRuleAncestors(compiled, targetSegments)) {
    if (step.depth >= targetDepth || step.node.validate === undefined) continue;
    const ancestorPath = canonicalRtdbPath(targetSegments.slice(0, step.depth));
    if (!lookup.isPathKnown(ancestorPath)) missing.push(ancestorPath);
  }
  return missing;
}
