// Multi-engine differential execution harness and outcome normalizer.
// Compares in-process Policy IR interpreter, compiled zero-dependency ES modules,
// and lowered Firestore, RTDB (.validate and .write), and Storage Rules v2 simulators.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EvalError, ResourceLimitError } from '../../src/simulator/eval-error.js';
import { firestoreRules } from '../../src/api/firestore.js';
import { rtdbRules } from '../../src/api/rtdb.js';
import { storageRules } from '../../src/api/storage.js';
import { compilePolicy, type RtdbBindings, type Transition, type Verdict } from '../../src/policy/index.js';

export type NormalizedOutcome =
  | { readonly kind: 'value'; readonly value: unknown; readonly repr: string }
  | { readonly kind: 'eval-error'; readonly message: string }
  | { readonly kind: 'resource-limit'; readonly message: string }
  | { readonly kind: 'unexpected-error'; readonly ctor: string; readonly message: string };

export type Decision = 'ALLOW' | 'DENY';

export type DetailedVerdictKind = 'allow' | 'deny-false' | 'eval-error' | 'resource-limit';

export interface DetailedVerdict {
  readonly kind: DetailedVerdictKind;
  readonly requirement?: string;
  readonly reason?: string;
}

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

// Strict typed error classifier. Unexpected JS host errors (TypeError, RangeError,
// ReferenceError, SyntaxError, URIError, or untyped Error) stay distinct so crashes
// can never be silently masked as recoverable parity.
export function classifyError(error: unknown): NormalizedOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const ctorName = error instanceof Error ? error.constructor.name : typeof error;
  const name = error instanceof Error ? error.name : '';
  if (
    error instanceof ResourceLimitError ||
    ctorName === 'ResourceLimitError' ||
    name === 'ResourceLimitError'
  ) {
    return { kind: 'resource-limit', message };
  }
  if (
    error instanceof EvalError ||
    ctorName === 'RuleError' ||
    name === 'RuleError'
  ) {
    return { kind: 'eval-error', message };
  }
  return { kind: 'unexpected-error', ctor: ctorName || name || 'unknown', message };
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

export function normalizeVerdictDetailed(verdict: Verdict): DetailedVerdict {
  if (verdict.ok) return { kind: 'allow' };
  if (verdict.fatal || verdict.trace?.outcome === 'resource-limit') {
    return { kind: 'resource-limit', requirement: verdict.requirement, reason: verdict.reason };
  }
  if (verdict.trace?.outcome === 'false') {
    return { kind: 'deny-false', requirement: verdict.requirement, reason: verdict.reason };
  }
  return { kind: 'eval-error', requirement: verdict.requirement, reason: verdict.reason };
}

export function decisionOf(outcome: NormalizedOutcome): Decision {
  return outcome.kind === 'value' && outcome.value === true ? 'ALLOW' : 'DENY';
}

export function outcomesMatch(a: NormalizedOutcome, b: NormalizedOutcome): boolean {
  if (a.kind === 'unexpected-error' || b.kind === 'unexpected-error') return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'value' && b.kind === 'value') return a.repr === b.repr;
  return true;
}

// Like outcomesMatch, treating safe int64 bigints from compileFunction as equal to
// safe JS integer numbers returned at the standalone ES module export boundary.
export function outcomesMatchWithSafeIntBridge(a: NormalizedOutcome, b: NormalizedOutcome): boolean {
  if (a.kind === 'unexpected-error' || b.kind === 'unexpected-error') return false;
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
// while fatal resource limits stay distinct via fatal:true and unexpected errors always fail.
export function verdictsMatch(a: NormalizedOutcome, b: NormalizedOutcome): boolean {
  if (a.kind === 'unexpected-error' || b.kind === 'unexpected-error') return false;
  if (a.kind === 'resource-limit' || b.kind === 'resource-limit') {
    return a.kind === 'resource-limit' && b.kind === 'resource-limit';
  }
  return decisionOf(a) === decisionOf(b);
}

// Four-way transition verdict equality distinguishing allow, deny-false,
// recoverable eval-error, and fatal resource-limit.
export function detailedVerdictsMatch(a: DetailedVerdict, b: DetailedVerdict): boolean {
  return a.kind === b.kind && a.requirement === b.requirement;
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

export interface PreparedFirestoreSim {
  readonly lowered: boolean;
  readonly loweredRequirements: readonly string[];
  readonly residualRequirements: readonly string[];
  readonly predicate?: string;
  readonly reason?: string;
  simulate(transition: Transition): Decision;
}

export function defaultFirestoreBindings(extra: Record<string, string> = {}): Record<string, string> {
  const bindings: Record<string, string> = {
    before: 'resource.data',
    after: 'request.resource.data',
    input: 'request.auth.token',
  };
  for (const k of ['x', 'y', 'z', 's', 'flag', 'tag', 'items', 'meta']) {
    bindings['before.' + k] = 'resource.data.' + k;
    bindings['after.' + k] = 'request.resource.data.' + k;
    bindings['input.' + k] = 'request.auth.token.' + k;
  }
  return { ...bindings, ...extra };
}

function buildFirestoreRuleset(predicate: string) {
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
  return firestoreRules(rulesSource);
}

function isPlainTokenRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function prepareFirestoreSim(
  policySource: string,
  options: { extraBindings?: Record<string, string>; allowPartial?: boolean } = {},
): PreparedFirestoreSim {
  const compiled = compilePolicy(policySource);
  const rows = compiled.firestore(defaultFirestoreBindings(options.extraBindings), 'mixed');
  const loweredRows = rows.filter((r) => Boolean(r.predicate) && !r.completeReason);
  const residualRows = rows.filter((r) => !r.predicate || Boolean(r.completeReason));
  const loweredRequirements = loweredRows.map((r) => r.requirement);
  const residualRequirements = residualRows.map((r) => r.requirement);
  const usable = options.allowPartial ? loweredRows.length > 0 : residualRows.length === 0;
  if (!usable) {
    return {
      lowered: false,
      loweredRequirements,
      residualRequirements,
      reason: residualRows.map((r) => r.completeReason ?? r.reason).join('; '),
      simulate: () => {
        throw new Error('Cannot simulate unlowered Firestore policy');
      },
    };
  }
  const predicate = loweredRows.map((r) => `(${r.predicate})`).join(' && ');
  const ruleset = buildFirestoreRuleset(predicate);
  return {
    lowered: residualRows.length === 0,
    loweredRequirements,
    residualRequirements,
    predicate,
    simulate(transition: Transition): Decision {
      const token = isPlainTokenRecord(transition.input) ? transition.input : undefined;
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
      return row.decision;
    },
  };
}

export function simulateFirestorePolicy(
  policySource: string,
  transition: Transition,
): { lowered: boolean; decision?: Decision; predicate?: string; reason?: string } {
  const prep = prepareFirestoreSim(policySource);
  if (!prep.lowered) return { lowered: false, reason: prep.reason };
  return { lowered: true, decision: prep.simulate(transition), predicate: prep.predicate };
}

export interface PreparedRtdbSim {
  readonly lowered: boolean;
  readonly loweredRequirements: readonly string[];
  readonly residualRequirements: readonly string[];
  readonly predicate?: string;
  readonly reason?: string;
  simulate(before: unknown, after: unknown): Decision;
}

export function prepareRtdbSim(
  policySource: string,
  options: { bindings?: RtdbBindings; ruleKind?: 'validate' | 'write'; allowPartial?: boolean } = {},
): PreparedRtdbSim {
  const compiled = compilePolicy(policySource);
  const bindings: RtdbBindings = options.bindings ?? { before: 'data', after: 'newData' };
  const ruleKind = options.ruleKind ?? 'validate';
  const rows = compiled.rtdb(bindings, 'mixed');
  const loweredRows = rows.filter((r) => Boolean(r.predicate));
  const residualRows = rows.filter((r) => !r.predicate);
  const loweredRequirements = loweredRows.map((r) => r.requirement);
  const residualRequirements = residualRows.map((r) => r.requirement);
  const usable = options.allowPartial ? loweredRows.length > 0 : residualRows.length === 0;
  if (!usable) {
    return {
      lowered: false,
      loweredRequirements,
      residualRequirements,
      reason: residualRows.map((r) => r.reason).join('; '),
      simulate: () => {
        throw new Error('Cannot simulate unlowered RTDB policy');
      },
    };
  }
  const predicate = loweredRows.map((r) => `(${r.predicate})`).join(' && ');
  const itemRule = ruleKind === 'write'
    ? { '.write': predicate }
    : { '.write': 'newData.exists()', '.validate': predicate };
  const ruleset = rtdbRules({ rules: { item: itemRule } });
  return {
    lowered: residualRows.length === 0,
    loweredRequirements,
    residualRequirements,
    predicate,
    simulate(before: unknown, after: unknown): Decision {
      const wrapMap = (v: unknown): unknown => {
        if (ruleKind === 'write') return v;
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          return Object.keys(v as Record<string, unknown>).length ? v : { _keep: true };
        }
        return v;
      };
      const beforeWire = wrapMap(before);
      const afterWire = wrapMap(after);
      const dataRoot = beforeWire === null || beforeWire === undefined ? {} : { item: beforeWire };
      const summary = ruleset.simulate([
        {
          path: '/item',
          operation: 'write',
          expectation: 'ALLOW',
          data: dataRoot,
          newData: afterWire,
        },
      ]);
      const row = summary.cases[0];
      if (!row || (row.decision !== 'ALLOW' && row.decision !== 'DENY')) {
        throw new Error('RTDB simulator returned unsupported/empty decision: ' + JSON.stringify(row));
      }
      return row.decision;
    },
  };
}

export function simulateRtdbPolicy(
  policySource: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { lowered: boolean; decision?: Decision; predicate?: string; reason?: string } {
  const prep = prepareRtdbSim(policySource);
  if (!prep.lowered) return { lowered: false, reason: prep.reason };
  return { lowered: true, decision: prep.simulate(before, after), predicate: prep.predicate };
}

export interface StorageResourceInput {
  size: number;
  contentType: string;
  name?: string;
  metadata?: Record<string, string>;
  contentDisposition?: string;
  cacheControl?: string;
}

export interface StorageSimInput {
  readonly method: 'create' | 'update';
  readonly path?: string;
  readonly auth: { uid: string; token?: Record<string, unknown> } | null;
  readonly before?: StorageResourceInput;
  readonly after: StorageResourceInput;
}

export interface PreparedStorageSim {
  readonly lowered: boolean;
  readonly loweredRequirements: readonly string[];
  readonly residualRequirements: readonly string[];
  readonly predicate?: string;
  readonly reason?: string;
  simulate(input: StorageSimInput): Decision;
}

export function prepareStorageSim(
  policySource: string,
  method: 'create' | 'update',
  options: { allowPartial?: boolean; wildcard?: boolean } = {},
): PreparedStorageSim {
  const compiled = compilePolicy(policySource);
  const rows = compiled.storage(
    { 'input.auth': 'request.auth', before: 'resource', after: 'request.resource' },
    'mixed',
  );
  const loweredRows = rows.filter((r) => Boolean(r.predicate) && !r.completeReason);
  const residualRows = rows.filter((r) => !r.predicate || Boolean(r.completeReason));
  const loweredRequirements = loweredRows.map((r) => r.requirement);
  const residualRequirements = residualRows.map((r) => r.requirement);
  const usable = options.allowPartial ? loweredRows.length > 0 : residualRows.length === 0;
  if (!usable) {
    return {
      lowered: false,
      loweredRequirements,
      residualRequirements,
      reason: residualRows.map((r) => r.completeReason ?? r.reason).join('; '),
      simulate: () => {
        throw new Error('Cannot simulate unlowered Storage policy');
      },
    };
  }
  const predicate = loweredRows.map((r) => `(${r.predicate})`).join(' && ');
  const matchClause = options.wildcard ? 'match /items/{rest=**} {' : 'match /items/{id} {';
  const rulesSource = [
    "rules_version = '2';",
    'service firebase.storage {',
    '  match /b/{bucket}/o {',
    `    ${matchClause}`,
    `      allow ${method}: if ${predicate};`,
    '    }',
    '  }',
    '}',
  ].join('\n');
  const ruleset = storageRules(rulesSource, { bucket: 'fuzz-bucket' });
  return {
    lowered: residualRows.length === 0,
    loweredRequirements,
    residualRequirements,
    predicate,
    simulate(input: StorageSimInput): Decision {
      const summary = ruleset.simulate([
        {
          description: 'fuzz-storage',
          method: input.method,
          path: input.path ?? 'items/obj1',
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
      return row.decision;
    },
  };
}

export function simulateStoragePolicy(
  policySource: string,
  input: StorageSimInput,
): { lowered: boolean; decision?: Decision; predicate?: string; reason?: string } {
  const prep = prepareStorageSim(policySource, input.method, {
    wildcard: Boolean(input.path && input.path.split('/').length > 2),
  });
  if (!prep.lowered) return { lowered: false, reason: prep.reason };
  return { lowered: true, decision: prep.simulate(input), predicate: prep.predicate };
}
