// Multi-engine differential execution harness and outcome normalizer.
// Compares in-process Policy IR interpreter, compiled zero-dependency ES modules,
// and lowered Firestore, RTDB, and Firebase Storage Rules v2 simulators.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EvalError, ResourceLimitError } from '../../src/simulator/eval-error.js';
import { firestoreRules } from '../../src/api/firestore.js';
import { rtdbRules } from '../../src/api/rtdb.js';
import { storageRules } from '../../src/api/storage.js';
import { compilePolicy, type Transition, type Verdict } from '../../src/policy/index.js';

export type NormalizedOutcome =
  | { readonly kind: 'value'; readonly value: unknown; readonly repr: string }
  | { readonly kind: 'eval-error'; readonly message: string }
  | { readonly kind: 'resource-limit'; readonly message: string };

export type Decision = 'ALLOW' | 'DENY';

// Canonical value representation preserving -0 vs +0, NaN, Infinity, bigint vs number,
// and structural list/map equality for strict differential comparison.
export function canonicalValueRepr(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'boolean') return value ? 'bool:true' : 'bool:false';
  if (typeof value === 'bigint') return `bigint:${value.toString()}`;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'num:NaN';
    if (Object.is(value, -0)) return 'num:-0';
    if (value === Infinity) return 'num:+Inf';
    if (value === -Infinity) return 'num:-Inf';
    return `num:${value}`;
  }
  if (typeof value === 'string') return `str:${JSON.stringify(value)}`;
  if (value instanceof Uint8Array) return `bytes:${Array.from(value).join(',')}`;
  if (Array.isArray(value)) return '[' + value.map(canonicalValueRepr).join(',') + ']';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => `${JSON.stringify(k)}:${canonicalValueRepr(obj[k])}`).join(',') + '}';
  }
  return `other:${String(value)}`;
}

export function classifyError(error: unknown): NormalizedOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const ctorName = error instanceof Error ? error.constructor.name : '';
  const name = error instanceof Error ? error.name : '';
  if (
    error instanceof ResourceLimitError ||
    ctorName === 'ResourceLimitError' ||
    name === 'ResourceLimitError' ||
    /exceeds declared (bound|limit)|budget exceeded|bound exceeded|Nesting limit|Node limit/i.test(message)
  ) {
    return { kind: 'resource-limit', message };
  }
  if (error instanceof EvalError || ctorName === 'RuleError' || name === 'RuleError') {
    return { kind: 'eval-error', message };
  }
  return { kind: 'eval-error', message };
}

export function captureCall(fn: () => unknown): NormalizedOutcome {
  try {
    const value = fn();
    return { kind: 'value', value, repr: canonicalValueRepr(value) };
  } catch (error) {
    return classifyError(error);
  }
}

export function normalizeVerdict(verdict: Verdict): NormalizedOutcome {
  if (verdict.ok) return { kind: 'value', value: true, repr: 'bool:true' };
  if (verdict.fatal) return { kind: 'resource-limit', message: verdict.reason };
  return { kind: 'eval-error', message: verdict.reason };
}

export function decisionOf(outcome: NormalizedOutcome): Decision {
  return outcome.kind === 'value' && outcome.value === true ? 'ALLOW' : 'DENY';
}

export function outcomesMatch(a: NormalizedOutcome, b: NormalizedOutcome): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'value' && b.kind === 'value') return a.repr === b.repr;
  return true;
}

// Like outcomesMatch, treating safe int64 bigints from compileFunction as equal to
// safe JS integer numbers returned at the standalone ES module export boundary.
export function outcomesMatchWithSafeIntBridge(a: NormalizedOutcome, b: NormalizedOutcome): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'value' && b.kind === 'value') {
    if (a.repr === b.repr) return true;
    const norm = (v: unknown): unknown => {
      if (typeof v === 'bigint' && v >= -9007199254740991n && v <= 9007199254740991n) return Number(v);
      return v;
    };
    return canonicalValueRepr(norm(a.value)) === canonicalValueRepr(norm(b.value));
  }
  return true;
}

// Transition verdicts map false and recoverable eval-error both to ok:false (non-fatal),
// while fatal resource limits stay distinct via fatal:true.
export function verdictsMatch(a: NormalizedOutcome, b: NormalizedOutcome): boolean {
  if (a.kind === 'resource-limit' || b.kind === 'resource-limit') {
    return a.kind === 'resource-limit' && b.kind === 'resource-limit';
  }
  return decisionOf(a) === decisionOf(b);
}

export interface ModuleLoader {
  load(moduleSource: string, tag?: string): Promise<Record<string, (...args: unknown[]) => unknown>>;
  cleanup(): void;
}

export function createModuleLoader(prefix = 'pyric-diff-fuzz-'): ModuleLoader {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  let seq = 0;
  return {
    async load(moduleSource: string, tag = 'mod') {
      const file = join(dir, `${tag}-${seq++}.mjs`);
      writeFileSync(file, moduleSource, 'utf8');
      return (await import(pathToFileURL(file).href)) as Record<string, (...args: unknown[]) => unknown>;
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function simulateFirestorePolicy(
  policySource: string,
  transition: Transition,
): { lowered: boolean; decision?: Decision; predicate?: string; reason?: string } {
  const compiled = compilePolicy(policySource);
  const bindings: Record<string, string> = {
    before: 'resource.data',
    after: 'request.resource.data',
    input: 'request.auth.token',
  };
  for (const k of ['x', 'y', 's', 'flag', 'tag']) {
    bindings['before.' + k] = 'resource.data.' + k;
    bindings['after.' + k] = 'request.resource.data.' + k;
    bindings['input.' + k] = 'request.auth.token.' + k;
  }
  const rows = compiled.firestore(bindings, 'mixed');
  if (rows.some((r) => !r.predicate || r.completeReason)) {
    return { lowered: false, reason: rows.map((r) => r.completeReason ?? r.reason).join('; ') };
  }
  const predicate = rows.map((r) => `(${r.predicate})`).join(' && ');
  const rulesSource = [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    '    match /items/{id} {',
    `      allow update: if ${predicate};`,
    '    }',
    '  }',
    '}',
  ].join('\n');
  const ruleset = firestoreRules(rulesSource);
  const token = transition.input && typeof transition.input === 'object'
    ? (transition.input as Record<string, unknown>)
    : undefined;
  const auth = token ? { uid: 'u1', token } : null;
  const summary = ruleset.simulate([
    {
      description: 'fuzz-firestore',
      method: 'update',
      path: 'items/doc1',
      expectation: 'ALLOW',
      auth,
      resource: transition.before as Record<string, unknown>,
      data: transition.after as Record<string, unknown>,
    },
  ]);
  const row = summary.cases[0];
  if (!row || (row.decision !== 'ALLOW' && row.decision !== 'DENY')) {
    throw new Error('Firestore simulator returned unsupported/empty decision: ' + JSON.stringify(row));
  }
  return { lowered: true, decision: row.decision, predicate };
}

export function simulateRtdbPolicy(
  policySource: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { lowered: boolean; decision?: Decision; predicate?: string; reason?: string } {
  const compiled = compilePolicy(policySource);
  const rows = compiled.rtdb({ before: 'data', after: 'newData' }, 'mixed');
  if (rows.some((r) => !r.predicate)) {
    return { lowered: false, reason: rows.map((r) => r.reason).join('; ') };
  }
  const predicate = rows.map((r) => `(${r.predicate})`).join(' && ');
  const ruleset = rtdbRules({
    rules: {
      item: {
        '.write': 'newData.exists()',
        '.validate': predicate,
      },
    },
  });
  // Attach _keep sentinel so empty object maps do not delete the RTDB node (which skips .validate).
  const beforeWire = Object.keys(before).length ? before : { _keep: true };
  const afterWire = Object.keys(after).length ? after : { _keep: true };
  const summary = ruleset.simulate([
    {
      path: '/item',
      operation: 'write',
      expectation: 'ALLOW',
      data: { item: beforeWire },
      newData: afterWire,
    },
  ]);
  const row = summary.cases[0];
  if (!row || (row.decision !== 'ALLOW' && row.decision !== 'DENY')) {
    throw new Error('RTDB simulator returned unsupported/empty decision: ' + JSON.stringify(row));
  }
  return { lowered: true, decision: row.decision, predicate };
}

export interface StorageSimInput {
  readonly method: 'create' | 'update';
  readonly auth: { uid: string; token?: Record<string, unknown> } | null;
  readonly before?: { size: number; contentType: string; name?: string; metadata?: Record<string, string> };
  readonly after: { size: number; contentType: string; name?: string; metadata?: Record<string, string> };
}

export function simulateStoragePolicy(
  policySource: string,
  input: StorageSimInput,
): { lowered: boolean; decision?: Decision; predicate?: string; reason?: string } {
  const compiled = compilePolicy(policySource);
  const rows = compiled.storage(
    { 'input.auth': 'request.auth', before: 'resource', after: 'request.resource' },
    'mixed',
  );
  if (rows.some((r) => !r.predicate || r.completeReason)) {
    return { lowered: false, reason: rows.map((r) => r.completeReason ?? r.reason).join('; ') };
  }
  const predicate = rows.map((r) => `(${r.predicate})`).join(' && ');
  const rulesSource = [
    "rules_version = '2';",
    'service firebase.storage {',
    '  match /b/{bucket}/o {',
    '    match /items/{id} {',
    `      allow ${input.method}: if ${predicate};`,
    '    }',
    '  }',
    '}',
  ].join('\n');
  const ruleset = storageRules(rulesSource, { bucket: 'fuzz-bucket' });
  const summary = ruleset.simulate([
    {
      description: 'fuzz-storage',
      method: input.method,
      path: 'items/obj1',
      expectation: 'ALLOW',
      auth: input.auth,
      ...(input.before ? { resource: input.before } : {}),
      requestResource: input.after,
    },
  ]);
  const row = summary.cases[0];
  if (!row || (row.decision !== 'ALLOW' && row.decision !== 'DENY')) {
    throw new Error('Storage simulator returned unsupported/empty decision: ' + JSON.stringify(row));
  }
  return { lowered: true, decision: row.decision, predicate };
}
