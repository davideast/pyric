// Isomorphic helpers for `provePolicy` and `createPolicyGuard`:
// standalone ES module instantiation, seeded value generation, outcome normalization,
// and Firestore/RTDB target simulation bridges. Zero Node-only imports.
import { firestoreRules } from '../api/firestore.js';
import { rtdbRules } from '../api/rtdb.js';
import { EvalError, ResourceLimitError } from '../simulator/eval-error.js';
import type { CheckedPolicyIR } from './check.js';
import { toDiagnosticJsonValue } from './diagnostics.js';
import { revivePolicyValue } from './eval-ir.js';
import type { FirestoreBindings } from './firestore.js';
import type { PolicyProgramKind } from './ir.js';
import type { SnapshotBindings, Transition, Verdict } from './index.js';

/**
 * Instantiate an emitted standalone ES module in-process without dynamic module loading or Node APIs.
 * Works identically in browsers, edge workers, Node, and Bun.
 */
export function instantiateStandaloneModule(
  moduleSource: string,
): Record<string, (...args: unknown[]) => unknown> {
  const exported: string[] = [];
  let rewritten = moduleSource.replace(
    /^export\s+\{\s*([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)\s*\};$/gm,
    (_m, local: string, alias: string) => {
      exported.push(`${JSON.stringify(alias)}: ${local}`);
      return '';
    },
  );
  rewritten = rewritten.replace(/^export\s+function\s+([A-Za-z0-9_$]+)\s*\(/gm, (_m, name: string) => {
    exported.push(`${JSON.stringify(name)}: ${name}`);
    return `function ${name}(`;
  });
  const factory = new Function(`"use strict";\n${rewritten}\nreturn { ${exported.join(', ')} };`);
  return factory() as Record<string, (...args: unknown[]) => unknown>;
}

function stripCommentsAndStrings(source: string): string {
  return source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, ' ');
}

/** Detect policy kind from source syntax when `options.kind` is omitted. */
export function detectPolicyKind(source: string): PolicyProgramKind {
  const cleaned = stripCommentsAndStrings(source);
  if (/(^|[\s;])transition\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/.test(cleaned)) return 'transition';
  if (/use\s+extension\s+bounded\s*;/.test(cleaned) && /(^|[\s;])export\s+function\b/.test(cleaned)) {
    return 'module';
  }
  const fnMatches = cleaned.match(/(^|[\s;])(export\s+)?function\s+[A-Za-z_]/g);
  if (fnMatches && fnMatches.length > 1) return 'module';
  return 'function';
}

export type NormalizedOutcome =
  | { kind: 'ok'; value: unknown }
  | { kind: 'verdict'; ok: boolean; requirement?: string; fatal: boolean }
  | { kind: 'eval-error' }
  | { kind: 'resource-limit' }
  | { kind: 'explicit-fail'; message: string };

export function normalizeError(err: unknown): NormalizedOutcome {
  if (err instanceof ResourceLimitError) return { kind: 'resource-limit' };
  if (err instanceof Error && err.constructor.name === 'ResourceLimitError') return { kind: 'resource-limit' };
  if (err instanceof EvalError) return { kind: 'eval-error' };
  if (err instanceof Error && err.constructor.name === 'RuleError') return { kind: 'eval-error' };
  return { kind: 'explicit-fail', message: err instanceof Error ? err.message : String(err) };
}

export function normalizeVerdict(v: Verdict): NormalizedOutcome {
  if (v.ok) return { kind: 'verdict', ok: true, fatal: false };
  return { kind: 'verdict', ok: false, requirement: v.requirement, fatal: Boolean(v.fatal) };
}

export function outcomesEqual(a: NormalizedOutcome, b: NormalizedOutcome): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'verdict' && b.kind === 'verdict') {
    return a.ok === b.ok && a.fatal === b.fatal && (a.ok || a.requirement === b.requirement);
  }
  if (a.kind === 'ok' && b.kind === 'ok') {
    return JSON.stringify(toDiagnosticJsonValue(a.value)) === JSON.stringify(toDiagnosticJsonValue(b.value));
  }
  if (a.kind === 'explicit-fail' && b.kind === 'explicit-fail') {
    return a.message === b.message;
  }
  return true;
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ADVERSARIAL_SCALARS: readonly unknown[] = [
  0,
  -0,
  1,
  -1,
  2,
  10,
  1.5,
  -0.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  2 ** 53,
  '',
  'a',
  'vip',
  true,
  false,
  null,
  [],
  [0, 1],
  [1, 2, 3, 4, 5],
];

function setNestedPath(target: Record<string, unknown>, segments: string[], value: unknown): void {
  let cur = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (!cur[seg] || typeof cur[seg] !== 'object' || Array.isArray(cur[seg])) {
      cur[seg] = {};
    }
    cur = cur[seg] as Record<string, unknown>;
  }
  const last = segments[segments.length - 1];
  if (last) cur[last] = value;
}

export function randomScalar(next: () => number, includeAdversarial: boolean): unknown {
  if (includeAdversarial && next() < 0.35) {
    return ADVERSARIAL_SCALARS[Math.floor(next() * ADVERSARIAL_SCALARS.length)];
  }
  const bucket = Math.floor(next() * 6);
  if (bucket === 0) return Math.floor(next() * 21) - 5;
  if (bucket === 1) return Math.round((next() * 20 - 5) * 4) / 4;
  if (bucket === 2) return next() < 0.5;
  if (bucket === 3) return ['a', 'b', 'vip', ''][Math.floor(next() * 4)];
  if (bucket === 4) return null;
  const len = Math.floor(next() * 5);
  return Array.from({ length: len }, () => Math.floor(next() * 10) - 2);
}

export function generateTransitionCase(
  checked: CheckedPolicyIR,
  next: () => number,
  includeAdversarial: boolean,
): Transition {
  const roots: Record<'before' | 'after' | 'input', Record<string, unknown>> = {
    before: {},
    after: {},
    input: {},
  };
  const allPaths = new Set<string>();
  for (const set of checked.reads.values()) {
    for (const p of set) allPaths.add(p);
  }
  for (const path of allPaths) {
    const [root, ...rest] = path.split('.');
    if (root !== 'before' && root !== 'after' && root !== 'input') continue;
    if (!rest.length) continue;
    if (includeAdversarial && next() < 0.15) continue;
    setNestedPath(roots[root], rest, randomScalar(next, includeAdversarial));
  }
  return roots;
}

function hasNonJsonNumber(value: unknown, depth = 0): boolean {
  if (depth > 16 || value === null || value === undefined) return false;
  if (typeof value === 'number') return Object.is(value, -0) || !Number.isFinite(value);
  if (typeof value === 'bigint') return true;
  if (Array.isArray(value)) return value.some((v) => hasNonJsonNumber(v, depth + 1));
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) => hasNonJsonNumber(v, depth + 1));
  }
  return false;
}

function readNested(root: unknown, segments: readonly string[]): { present: boolean; value: unknown } {
  let cur: unknown = root;
  for (const seg of segments) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur) || !Object.hasOwn(cur, seg)) {
      return { present: false, value: undefined };
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  return { present: true, value: cur };
}

function readTransitionPath(transition: Transition, policyPath: string): { present: boolean; value: unknown } {
  const [root, ...rest] = policyPath.split('.');
  const rootObj =
    root === 'before' ? transition.before : root === 'after' ? transition.after : root === 'input' ? transition.input : undefined;
  if (!rest.length) return { present: rootObj !== undefined, value: rootObj };
  return readNested(rootObj, rest);
}

const SUPPORTED_FS_BINDING = /^(?:resource\.data(?:\.[A-Za-z_][A-Za-z0-9_]*)*|request\.resource\.data(?:\.[A-Za-z_][A-Za-z0-9_]*)*|request\.auth(?:\.uid|\.token(?:\.[A-Za-z_][A-Za-z0-9_]*)+)?)$/;

/** Pre-compile a lowered Firestore module once for fast scenario + fuzz replay. */
export function createFirestoreEvaluator(
  moduleSource: string,
  fnName: string,
  bindings: FirestoreBindings,
): ((transition: Transition) => string | undefined) | undefined {
  const entries = Object.entries(bindings);
  if (entries.some(([, target]) => !SUPPORTED_FS_BINDING.test(target))) return undefined;
  const body = moduleSource.slice(moduleSource.indexOf('export function') + 'export '.length);
  const rules = firestoreRules(`rules_version = '2'; service cloud.firestore {
    match /databases/{db}/documents {
      ${body}
      match /items/{id} { allow update: if ${fnName}(); }
    }
  }`);
  const hasAuthBinding = entries.some(([, target]) => target === 'request.auth' || target.startsWith('request.auth.'));
  return (transition: Transition) => {
    const resource: Record<string, unknown> =
      transition.before && typeof transition.before === 'object' && !Array.isArray(transition.before)
        ? (revivePolicyValue(transition.before) as Record<string, unknown>)
        : {};
    const data: Record<string, unknown> =
      transition.after && typeof transition.after === 'object' && !Array.isArray(transition.after)
        ? (revivePolicyValue(transition.after) as Record<string, unknown>)
        : {};
    let auth: { uid: string; token?: Record<string, unknown> } | null | undefined;
    if (hasAuthBinding) {
      let uid: unknown;
      let uidPresent = false;
      const token: Record<string, unknown> = {};
      let hasToken = false;
      for (const [policyPath, target] of entries) {
        if (target === 'request.auth.uid') {
          const r = readTransitionPath(transition, policyPath);
          uidPresent = r.present;
          uid = r.value;
        } else if (target.startsWith('request.auth.token.')) {
          const r = readTransitionPath(transition, policyPath);
          if (r.present) {
            setNestedPath(token, target.slice('request.auth.token.'.length).split('.'), revivePolicyValue(r.value));
            hasToken = true;
          }
        } else if (target === 'request.auth') {
          const r = readTransitionPath(transition, policyPath);
          if (r.present && r.value && typeof r.value === 'object' && !Array.isArray(r.value)) {
            const obj = r.value as Record<string, unknown>;
            if (typeof obj.uid === 'string') {
              uidPresent = true;
              uid = obj.uid;
            }
          }
        }
      }
      if (uidPresent && uid !== null && typeof uid !== 'string') return undefined;
      if (typeof uid === 'string') {
        auth = hasToken ? { uid, token } : { uid };
      } else if (hasToken) {
        auth = { uid: '', token };
      } else {
        auth = null;
      }
    }
    const [row] = rules.simulate([
      {
        description: 'provePolicy',
        method: 'update',
        path: 'items/one',
        resource,
        data,
        ...(hasAuthBinding ? { auth } : {}),
        expectation: 'ALLOW',
      },
    ]).cases;
    return row?.unsupported ? undefined : row?.decision;
  };
}

/** Pre-compile lowered RTDB `.write` rules once for fast scenario + fuzz replay. */
export function createRtdbEvaluator(
  predicates: string[],
  bindings: SnapshotBindings,
): ((transition: Transition) => string | undefined) | undefined {
  if (!predicates.length) return undefined;
  const beforeEntry = Object.entries(bindings).find(([k, v]) => k.startsWith('before.') && v === 'data');
  const afterEntry = Object.entries(bindings).find(([k, v]) => k.startsWith('after.') && v === 'newData');
  if (!beforeEntry || !afterEntry) return undefined;
  const beforePath = beforeEntry[0].split('.').slice(1);
  const afterPath = afterEntry[0].split('.').slice(1);
  const expr = predicates.map((p) => `(${p})`).join(' && ');
  // Enforce via `.write` (not `.validate`), because RTDB skips `.validate` on deletes (null / []).
  const rules = rtdbRules({ rules: { item: { '.write': expr } } });
  return (transition: Transition) => {
    if (hasNonJsonNumber(transition.before) || hasNonJsonNumber(transition.after)) return undefined;
    const bVal = readNested(transition.before, beforePath);
    const aVal = readNested(transition.after, afterPath);
    const [row] = rules.simulate([
      {
        path: '/item',
        operation: 'write',
        expectation: 'ALLOW',
        data: bVal.present ? { item: bVal.value } : {},
        newData: aVal.present ? aVal.value : null,
      },
    ]).cases;
    return row?.decision;
  };
}
