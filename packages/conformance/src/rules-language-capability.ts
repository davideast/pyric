/**
 * Rules-language simulator capability probe (issue #185, step 3).
 *
 * For every construct in each language snapshot, GENERATE a micro-scenario
 * that exercises just that construct and run it through the corresponding
 * simulator (the Firestore evaluator, the Storage evaluator, the RTDB
 * rules engine). Classify the result:
 *
 *   - `implemented`  — the evaluator evaluated the construct (any ALLOW/DENY
 *                      verdict that is not an abstain and not a probe error).
 *   - `unsupported`  — the evaluator ABSTAINED (Firestore UNSUPPORTED /
 *                      RTDB `unsupported` / Storage deny-with-unsupported-reason
 *                      / parser rejects the construct). This is the
 *                      unimplemented set the language-coverage number counts
 *                      against.
 *   - `error`        — the micro-scenario threw or produced an eval-error
 *                      verdict (a malformed probe, surfaced honestly).
 *   - `unprobeable`  — no micro-scenario can be auto-generated for the
 *                      construct (behavioral semantics, module resolution,
 *                      unmodeled fields that read as undefined). Carries a
 *                      reason; the count is reported, never forced.
 *
 * Running this file writes an ignored rules-language/capability-report.json
 * inspection artifact. Runtime consumers call computeCapabilityReport() in
 * memory instead. The per-engine
 * language-coverage number is implemented / (implemented + unsupported),
 * i.e. probeable constructs the simulator evaluates over those it could.
 */
import {
  parseStorageRules,
  evaluateStorageRules,
  type EvaluationInput,
} from '../../../packages/pyric/src/storage/rules.ts';
import {
  compileRtdbRules,
  simulateRtdbRules,
  type CompiledRtdbRules,
} from '../../../packages/pyric/src/rules/rtdb/compiled-rules.ts';
import type { SimulationInput } from '../../../packages/pyric/src/rules/rtdb/simulation/spec.ts';
import { loadSnapshot, type LanguageConstruct, type RulesEngine } from '../rules-language/load.ts';
import { evaluateFirestoreCapability } from './firestore-rules-capability-evaluation.ts';

export type Classification = 'implemented' | 'unsupported' | 'error' | 'unprobeable';

export interface ConstructCapability {
  id: string;
  kind: string;
  classification: Classification;
  /** Detail: the verdict/reason the simulator produced, or the unprobeable
   *  reason. */
  detail: string;
  /** Current canonical production/local microprobe identity (Firestore). */
  probeDigest?: { algorithm: 'sha256'; value: string };
  /** Whether the local verdict matches the canonical probe expectation. */
  evaluationAgreement?: boolean;
}

// ════════════════════════════════════════════════════════════════════
// FIRESTORE
// ════════════════════════════════════════════════════════════════════

export { resolveFirestoreConstructProbe } from './firestore-rules-capability-probes.ts';
import { resolveFirestoreConstructProbe } from './firestore-rules-capability-probes.ts';

// ════════════════════════════════════════════════════════════════════
// STORAGE
// ════════════════════════════════════════════════════════════════════

export const ST_RULESET = (expr: string, verb = 'read') => `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /probe/{id} {
      allow ${verb}: if ${expr};
    }
  }
}`;

/** Exported (issue #185 step 5) for the same one-generator-two-backends
 *  reason as {@link FsProbe}. */
export type StProbe = { expr: string; method?: EvaluationInput['request']['method'] } | { rules: string; input: EvaluationInput } | { unprobeable: string };

export const ST_INPUT: EvaluationInput = {
  request: {
    auth: { uid: 'u', token: { admin: true } },
    method: 'read',
    path: 'probe/x',
    resource: { size: 10, contentType: 'text/plain', metadata: { owner: 'u' } },
  },
  // The existing-object binding carries the object-identity/time fields, so a
  // `resource.name == resource.name` style micro-probe genuinely EVALUATES the
  // field. Leaving one out would make its probe hit the absent-property error
  // and deny — which `stRun` would score as `implemented` ("DENY: …") without
  // the construct ever having been read. The fields must be present for the
  // probe to mean anything.
  resource: {
    size: 10,
    contentType: 'text/plain',
    metadata: { owner: 'u' },
    name: 'probe/x',
    bucket: 'demo-pyric.appspot.com',
    timeCreated: '2025-01-01T00:00:00Z',
    updated: '2025-01-02T00:00:00Z',
    generation: 1,
    metageneration: 1,
  },
};

/**
 * Resolve an {@link StProbe} into the (rules, input) pair a rules-test
 * backend executes. Exported (issue #185 step 5) for the same
 * one-generator-two-backends reason as {@link resolveFsProbe}.
 */
export function resolveStProbe(probe: StProbe): { rules: string; input: EvaluationInput } | { unprobeable: string } {
  if ('unprobeable' in probe) return probe;
  if ('rules' in probe) return { rules: probe.rules, input: probe.input };
  const verb = probe.method ?? 'read';
  const rules = ST_RULESET(probe.expr, verb);
  const input: EvaluationInput = { ...ST_INPUT, request: { ...ST_INPUT.request, method: verb } };
  return { rules, input };
}

function stRun(probe: StProbe): { classification: Classification; detail: string } {
  const resolved = resolveStProbe(probe);
  if ('unprobeable' in resolved) return { classification: 'unprobeable', detail: resolved.unprobeable };
  const { rules, input } = resolved;
  let parsed;
  try {
    parsed = parseStorageRules(rules);
  } catch (e) {
    return { classification: 'error', detail: `parse threw: ${(e as Error).message}` };
  }
  let result;
  try {
    result = evaluateStorageRules(parsed, input);
  } catch (e) {
    return { classification: 'error', detail: `eval threw: ${(e as Error).message}` };
  }
  if (result.allowed) return { classification: 'implemented', detail: 'ALLOW' };
  const reason = result.reasons.join('; ');
  if (/unsupported|unknown|not supported|no firestore lookup|cannot resolve/i.test(reason)) {
    return { classification: 'unsupported', detail: reason };
  }
  // A plain deny of a tautology means the construct evaluated but the value was
  // falsy — still exercised (implemented), unless the reason flags abstention.
  return { classification: 'implemented', detail: `DENY: ${reason}` };
}

const ST_EXPR: Record<string, StProbe> = {
  'storage.function.timestamp.date': { expr: 'request.time < timestamp.date(2999, 1, 1)' },
  'storage.function.timestamp.value': { expr: 'request.time < timestamp.value(99999999999999)' },
  'storage.function.duration.value': { expr: "request.time < resource.timeCreated + duration.value(99999, 'd')" },
  'storage.function.firestore.get': { expr: "firestore.get(/databases/(default)/documents/u/x).data.k == 'v'" },
  'storage.function.firestore.exists': { expr: 'firestore.exists(/databases/(default)/documents/u/x)' },
  'storage.method.string.matches': { expr: "request.resource.contentType.matches('text/.*')" },
  'storage.operator.eq': { expr: 'request.resource.size == 10' },
  'storage.operator.neq': { expr: 'request.resource.size != 0' },
  'storage.operator.lt': { expr: 'request.resource.size < 100' },
  'storage.operator.gt': { expr: 'request.resource.size > 1' },
  'storage.operator.lte': { expr: 'request.resource.size <= 10' },
  'storage.operator.gte': { expr: 'request.resource.size >= 10' },
  'storage.operator.add': { expr: 'request.resource.size + 1 == 11' },
  'storage.operator.sub': { expr: 'request.resource.size - 1 == 9' },
  'storage.operator.mul': { expr: 'request.resource.size * 2 == 20' },
  'storage.operator.div': { expr: 'request.resource.size / 2 == 5' },
  'storage.operator.and': { expr: 'request.auth != null && request.resource.size == 10' },
  'storage.operator.or': { expr: 'request.auth == null || request.resource.size == 10' },
  'storage.operator.not': { expr: '!(request.auth == null)' },
  'storage.operator.member': { expr: 'request.resource.metadata.owner == request.auth.uid' },
  'storage.operator.index': { expr: "request.resource.metadata['owner'] == request.auth.uid" },
  // The existing-object identity/time fields. These carry a descriptive `note`
  // (production's semantics for the field), and the generic binding branch
  // below treats ANY noted binding as unprobeable — a heuristic meant for
  // UNMODELED fields. They are modeled now, so give each an explicit probe;
  // ST_EXPR is consulted before that heuristic.
  'storage.binding.resource.name': { expr: "resource.name.matches('probe/.*')" },
  'storage.binding.resource.bucket': { expr: 'resource.bucket == resource.bucket' },
  // Both timestamp probes compare the two object timestamps against EACH OTHER
  // rather than against `request.time`. A `request.time` comparison is not
  // time-independent: the acceptance probe pins production's request.time to
  // PROBE_TIME (2024) while the local capability probe defaults it to the
  // wall clock, so the two backends would disagree on a fixed timeCreated —
  // a harness artifact, not a fidelity signal. ST_INPUT has
  // timeCreated (Jan 1) strictly before updated (Jan 2), so both are
  // deterministically ALLOW on either backend.
  'storage.binding.resource.timeCreated': { expr: 'resource.timeCreated < resource.updated' },
  'storage.binding.resource.updated': { expr: 'resource.updated > resource.timeCreated' },
};

export function stProbeFor(c: LanguageConstruct): StProbe {
  if (c.id in ST_EXPR) return ST_EXPR[c.id];
  if (c.kind === 'binding') {
    const name = c.id.slice('storage.binding.'.length);
    if (name === 'path-variable') return { expr: 'id == id' };
    // Fields the standalone evaluator does not model read as undefined and
    // cannot be told apart from implemented-but-absent by a micro-scenario.
    if (c.note) return { unprobeable: `${name} is unmodeled by the standalone evaluator (reads undefined); a micro-scenario cannot distinguish unimplemented from implemented-but-absent. ${c.note}` };
    if (name === 'request.method') return { expr: "request.method == 'get' || request.method == 'read'" };
    if (name === 'request.path') return { expr: 'request.path == request.path' };
    if (name === 'request.time') return { expr: 'request.time == request.time' };
    return { expr: `${name} == ${name}` };
  }
  if (c.kind === 'rule-kind') {
    const name = c.id.slice('storage.rule-kind.'.length);
    const verbMap: Record<string, EvaluationInput['request']['method']> = {
      'allow-read': 'get', 'allow-get': 'get', 'allow-list': 'list',
      'allow-write': 'create', 'allow-create': 'create', 'allow-update': 'update', 'allow-delete': 'delete',
    };
    if (name in verbMap) {
      const grant = name.slice('allow-'.length);
      const rules = ST_RULESET('true', grant);
      return { rules, input: { ...ST_INPUT, request: { ...ST_INPUT.request, method: verbMap[name] } } };
    }
    if (name === 'match') return { expr: 'true' };
    if (name === 'rules_version') return { expr: 'true' };
    if (name === 'function') {
      const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function ok() { return true; }
    match /probe/{id} { allow read: if ok(); }
  }
}`;
      return { rules, input: ST_INPUT };
    }
    if (name === 'let') {
      const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function ok() { let x = true; return x; }
    match /probe/{id} { allow read: if ok(); }
  }
}`;
      return { rules, input: ST_INPUT };
    }
  }
  if (c.kind === 'semantic') {
    const name = c.id.slice('storage.semantic.'.length);
    if (name === 'read-umbrella') {
      const rules = ST_RULESET('true', 'read');
      return { rules, input: { ...ST_INPUT, request: { ...ST_INPUT.request, method: 'get' } } };
    }
    if (name === 'write-umbrella') {
      const rules = ST_RULESET('true', 'write');
      return { rules, input: { ...ST_INPUT, request: { ...ST_INPUT.request, method: 'create' } } };
    }
    if (name === 'recursive-wildcard') {
      const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /probe/{allPaths=**} { allow read: if true; }
  }
}`;
      return { rules, input: { ...ST_INPUT, request: { ...ST_INPUT.request, method: 'get', path: 'probe/a/b/c' } } };
    }
    if (name === 'deny-by-default') {
      const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /nothing/{id} { allow read: if true; }
  }
}`;
      // No matching rule for /probe/x → denied, evaluator reached its default.
      return { rules, input: ST_INPUT };
    }
  }
  return { unprobeable: `no generator for construct kind ${c.kind}` };
}

// ════════════════════════════════════════════════════════════════════
// RTDB
// ════════════════════════════════════════════════════════════════════

type RtProbe =
  | { read: string; op?: 'read' | 'write'; newData?: unknown; mockData?: unknown }
  | { subtree: Record<string, unknown>; op: 'read' | 'write'; opPath?: string; newData?: unknown; mockData?: unknown }
  | { unprobeable: string };

function rtRun(probe: RtProbe): { classification: Classification; detail: string } {
  if ('unprobeable' in probe) return { classification: 'unprobeable', detail: probe.unprobeable };
  let subtree: Record<string, unknown>;
  let op: 'read' | 'write';
  let opPath: string;
  let newData: unknown;
  let mockData: unknown;
  if ('subtree' in probe) {
    subtree = probe.subtree;
    op = probe.op;
    opPath = probe.opPath ?? '/probe';
    newData = probe.newData;
    mockData = probe.mockData ?? {};
  } else {
    op = probe.op ?? 'read';
    subtree = op === 'write' ? { probe: { '.write': probe.read } } : { probe: { '.read': probe.read } };
    opPath = '/probe';
    newData = probe.newData ?? (op === 'write' ? 'value' : undefined);
    mockData = probe.mockData ?? {};
  }
  const rules = { rules: { '.read': false, '.write': false, ...subtree } };
  let compiled: CompiledRtdbRules;
  try {
    compiled = compileRtdbRules(rules);
  } catch (e) {
    return { classification: 'error', detail: `compileRtdbRules threw: ${(e as Error).message}` };
  }
  const input: SimulationInput = {
    operation: op,
    path: opPath,
    auth: { uid: 'u', token: { admin: true } },
    mockData: (typeof mockData === 'object' && mockData !== null ? mockData : {}) as Record<string, unknown>,
    newData,
  };
  let res;
  try {
    res = simulateRtdbRules(compiled, input);
  } catch (e) {
    return { classification: 'error', detail: `execute threw: ${(e as Error).message}` };
  }
  if (!res.success) {
    const { code, message } = res.error;
    // NO_MATCHING_RULE is a genuine deny outcome (deny-by-default), not an
    // engine error — the simulator ran and found no governing rule.
    if (code === 'NO_MATCHING_RULE') return { classification: 'implemented', detail: `DENY (no matching rule): ${message}` };
    // The engine refusing an unknown/unsupported method is the unimplemented
    // set, not a malformed probe.
    if (code === 'EVALUATION_ERROR' && /unknown|unsupported|not supported/i.test(message)) {
      return { classification: 'unsupported', detail: `${code}: ${message}` };
    }
    return { classification: 'error', detail: `${code}: ${message}` };
  }
  if (res.data.unsupported) return { classification: 'unsupported', detail: `abstained: ${res.data.reason}` };
  return { classification: 'implemented', detail: `${res.data.allowed ? 'ALLOW' : 'DENY'}: ${res.data.reason}` };
}

const RT_EXPR: Record<string, RtProbe> = {
  // Snapshot methods
  'rtdb.method.snapshot.val': { read: 'data.val() === data.val()' },
  'rtdb.method.snapshot.child': { read: "data.child('x').val() === data.child('x').val()" },
  'rtdb.method.snapshot.parent': { read: 'data.exists() || data.parent() === data.parent()' },
  'rtdb.method.snapshot.hasChild': { op: 'write', read: "newData.hasChild('x') === newData.hasChild('x')", newData: { x: 1 } },
  'rtdb.method.snapshot.hasChildren': { op: 'write', read: 'newData.hasChildren() === newData.hasChildren()', newData: { x: 1 } },
  'rtdb.method.snapshot.exists': { read: 'data.exists() === data.exists()' },
  'rtdb.method.snapshot.getPriority': { read: 'data.getPriority() === data.getPriority()' },
  'rtdb.method.snapshot.isNumber': { op: 'write', read: 'newData.isNumber() === newData.isNumber()', newData: 5 },
  'rtdb.method.snapshot.isString': { op: 'write', read: 'newData.isString() === newData.isString()', newData: 'x' },
  'rtdb.method.snapshot.isBoolean': { op: 'write', read: 'newData.isBoolean() === newData.isBoolean()', newData: true },
  // String methods (on newData.val() of a string write)
  'rtdb.method.string.contains': { op: 'write', read: "newData.val().contains('b')", newData: 'abc' },
  'rtdb.method.string.beginsWith': { op: 'write', read: "newData.val().beginsWith('a')", newData: 'abc' },
  'rtdb.method.string.endsWith': { op: 'write', read: "newData.val().endsWith('c')", newData: 'abc' },
  'rtdb.method.string.matches': { op: 'write', read: 'newData.val().matches(/a.*/)', newData: 'abc' },
  'rtdb.method.string.replace': { op: 'write', read: "newData.val().replace('a', 'z') === 'zbc'", newData: 'abc' },
  'rtdb.method.string.toLowerCase': { op: 'write', read: "newData.val().toLowerCase() === 'abc'", newData: 'ABC' },
  'rtdb.method.string.toUpperCase': { op: 'write', read: "newData.val().toUpperCase() === 'ABC'", newData: 'abc' },
  'rtdb.method.string.length': { op: 'write', read: 'newData.val().length === 3', newData: 'abc' },
  // Operators
  'rtdb.operator.strictEq': { read: '1 === 1' },
  'rtdb.operator.strictNeq': { read: '1 !== 2' },
  'rtdb.operator.looseEq': { read: '1 == 1' },
  'rtdb.operator.looseNeq': { read: '1 != 2' },
  'rtdb.operator.gte': { read: '2 >= 1' },
  'rtdb.operator.lte': { read: '1 <= 1' },
  'rtdb.operator.gt': { read: '2 > 1' },
  'rtdb.operator.lt': { read: '1 < 2' },
  'rtdb.operator.add': { read: '1 + 1 === 2' },
  'rtdb.operator.sub': { read: '2 - 1 === 1' },
  'rtdb.operator.mul': { read: '2 * 3 === 6' },
  'rtdb.operator.div': { read: '6 / 2 === 3' },
  'rtdb.operator.mod': { read: '5 % 2 === 1' },
  'rtdb.operator.and': { read: 'true && true' },
  'rtdb.operator.or': { read: 'false || true' },
  'rtdb.operator.not': { read: '!false' },
  'rtdb.operator.neg': { read: '-1 < 0' },
  'rtdb.operator.ternary': { read: '(true ? true : false)' },
  'rtdb.operator.member': { read: 'auth.uid === auth.uid' },
  'rtdb.operator.index': { read: "['a', 'b'][0] === 'a'" },
  // Bindings
  'rtdb.binding.auth': { read: 'auth !== null' },
  'rtdb.binding.auth.uid': { read: 'auth.uid === auth.uid' },
  'rtdb.binding.auth.token': { read: 'auth.token === auth.token' },
  'rtdb.binding.data': { read: 'data.val() === data.val()' },
  'rtdb.binding.newData': { op: 'write', read: 'newData.val() === newData.val()', newData: 'v' },
  'rtdb.binding.root': { read: "root.child('x').exists() === root.child('x').exists()" },
  'rtdb.binding.now': { op: 'write', read: 'now > 0', newData: 'v' },
};

function rtProbeFor(c: LanguageConstruct): RtProbe {
  if (c.id in RT_EXPR) return RT_EXPR[c.id];
  if (c.kind === 'binding' && c.id === 'rtdb.binding.path-variable') {
    return { subtree: { $id: { '.read': '$id === $id' } }, op: 'read', opPath: '/anything' };
  }
  if (c.kind === 'rule-kind') {
    const name = c.id.slice('rtdb.rule-kind.'.length);
    if (name === 'read') return { read: 'true', op: 'read' };
    if (name === 'write') return { subtree: { probe: { '.write': 'true' } }, op: 'write', newData: 'v' };
    if (name === 'validate') return { subtree: { probe: { '.write': 'true', '.validate': 'newData.isString()' } }, op: 'write', newData: 'v' };
    if (name === 'indexOn') return { subtree: { probe: { '.read': 'true', '.indexOn': ['x'] } }, op: 'read' };
    if (name === 'location-wildcard') return { subtree: { $id: { '.read': 'true' } }, op: 'read', opPath: '/anything' };
  }
  if (c.kind === 'semantic') {
    const name = c.id.slice('rtdb.semantic.'.length);
    if (name === 'read-cascade') return { subtree: { probe: { '.read': 'true', child: {} } }, op: 'read', opPath: '/probe/child' };
    if (name === 'write-cascade') return { subtree: { probe: { '.write': 'true', child: {} } }, op: 'write', opPath: '/probe/child', newData: 'v' };
    if (name === 'validate-non-cascade') {
      return { unprobeable: 'validate non-cascade is a multi-node relationship (a parent .validate must NOT govern a deeper write); it is not a single allow/deny micro-scenario.' };
    }
    if (name === 'deny-by-default') return { subtree: { probe: {} }, op: 'read', opPath: '/probe' };
    if (name === 'regex-literal') return { op: 'write', read: 'newData.val().matches(/^a/)', newData: 'abc' };
  }
  return { unprobeable: `no generator for construct kind ${c.kind}` };
}

// ════════════════════════════════════════════════════════════════════
// Driver
// ════════════════════════════════════════════════════════════════════

export function probeEngine(engine: RulesEngine): ConstructCapability[] {
  const snapshot = loadSnapshot(engine);
  const out: ConstructCapability[] = [];
  for (const c of snapshot.constructs) {
    let r: Pick<ConstructCapability, 'classification' | 'detail' | 'probeDigest' | 'evaluationAgreement'>;
    if (engine === 'firestore') {
      const resolved = resolveFirestoreConstructProbe(c);
      r = evaluateFirestoreCapability(resolved);
    }
    else if (engine === 'storage') r = stRun(stProbeFor(c));
    else r = rtRun(rtProbeFor(c));
    out.push({
      id: c.id, kind: c.kind, classification: r.classification, detail: r.detail,
      ...(r.probeDigest ? { probeDigest: r.probeDigest } : {}),
      ...(r.evaluationAgreement !== undefined ? { evaluationAgreement: r.evaluationAgreement } : {}),
    });
  }
  return out;
}

export interface EngineCapability {
  engine: RulesEngine;
  total: number;
  implemented: number;
  unsupported: number;
  error: number;
  unprobeable: number;
  /** implemented / (implemented + unsupported) — the language-coverage number
   *  over the auto-probeable constructs. */
  languageCoverage: number;
  constructs: ConstructCapability[];
}

export interface CapabilityReport {
  generatedNote: string;
  engines: EngineCapability[];
}

const RULES_ENGINES: readonly RulesEngine[] = ['firestore', 'storage', 'rtdb'] as const;

export function computeCapabilityReport(): CapabilityReport {
  const engines: EngineCapability[] = [];
  for (const engine of RULES_ENGINES) {
    const constructs = probeEngine(engine);
    const count = (k: Classification) => constructs.filter((c) => c.classification === k).length;
    const implemented = count('implemented');
    const unsupported = count('unsupported');
    const probeable = implemented + unsupported;
    engines.push({
      engine,
      total: constructs.length,
      implemented,
      unsupported,
      error: count('error'),
      unprobeable: count('unprobeable'),
      languageCoverage: probeable ? implemented / probeable : 0,
      constructs,
    });
  }
  return {
    generatedNote:
      'Supporting capability axis consumed by the strict Firestore Rules score gate. Language coverage = constructs the simulator EVALUATES / auto-probeable constructs (implemented + unsupported). `error` marks malformed micro-scenarios; `unprobeable` marks constructs no micro-scenario can auto-generate (behavioral semantics, module resolution, unmodeled fields).',
    engines,
  };
}

export async function writeCapabilityReport(): Promise<string> {
  const { writeFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = join(here, '..', 'rules-language', 'capability-report.json');
  writeFileSync(outPath, JSON.stringify(computeCapabilityReport(), null, 2) + '\n', 'utf8');
  return outPath;
}

if (import.meta.main) {
  const report = computeCapabilityReport();
  for (const e of report.engines) {
    console.log(
      `${e.engine}: implemented ${e.implemented}, unsupported ${e.unsupported}, error ${e.error}, ` +
        `unprobeable ${e.unprobeable} / ${e.total}; language coverage ` +
        `${(e.languageCoverage * 100).toFixed(1)}% (of ${e.implemented + e.unsupported} probeable)`,
    );
  }
  const outPath = await writeCapabilityReport();
  console.log(`Wrote ${outPath}`);
}
