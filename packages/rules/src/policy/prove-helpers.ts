// Isomorphic helpers for `provePolicy` and `createPolicyGuard`:
// standalone ES module instantiation, seeded value generation, and outcome normalization.
// Simulator bridges live in `target-evaluators.ts`. Zero Node-only imports.
import { EvalError, ResourceLimitError } from '../simulator/eval-error.js';
import type { CheckedPolicyIR } from './check.js';
import { toDiagnosticJsonValue } from './diagnostics.js';
import type { PolicyProgramKind } from './ir.js';
import type { Transition, Verdict } from './index.js';

export {
  createFirestoreEvaluator,
  createFirestorePredicateEvaluator,
  createRtdbEvaluator,
  createStorageEvaluator,
  generateStorageTransitionCase,
  inferStorageMethod,
  type StorageSimMethod,
  type TargetDecision,
} from './target-evaluators.js';

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

const FORBIDDEN_PATH_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function setNestedPath(target: Record<string, unknown>, segments: readonly string[], value: unknown): void {
  let cur = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (FORBIDDEN_PATH_KEYS.has(seg)) return;
    const existing = Object.hasOwn(cur, seg) ? cur[seg] : undefined;
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      const next: Record<string, unknown> = {};
      Object.defineProperty(cur, seg, { value: next, enumerable: true, writable: true, configurable: true });
      cur = next;
    } else {
      cur = existing as Record<string, unknown>;
    }
  }
  const last = segments[segments.length - 1];
  if (last && !FORBIDDEN_PATH_KEYS.has(last)) {
    Object.defineProperty(cur, last, { value, enumerable: true, writable: true, configurable: true });
  }
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
