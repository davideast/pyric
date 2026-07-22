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
import { SimulateFirestoreRulesHandler } from '../../../packages/pyric/src/rules/simulator/handler.ts';
import type { TestCase } from '../../../packages/pyric/src/rules/test/spec.ts';
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
import { firestoreRulesTestInputDigest } from './firestore-rules-input-digest.ts';

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

const fsSim = new SimulateFirestoreRulesHandler();

export const FS_RULESET = (expr: string, verb = 'read') => `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /probe/{id} {
      allow ${verb}: if ${expr};
    }
  }
}`;

/** A firestore probe: an expression evaluated in a standard get, or a full
 *  ruleset + case, or an unprobeable marker. Exported (issue #185 step 5)
 *  so the production acceptance probe (rules-language-acceptance.ts) reuses
 *  the SAME per-construct micro-scenario generator the capability probe
 *  uses against the local simulator — one generator, two backends. */
export type FsProbe =
  | { expr: string; method?: TestCase['method']; withMocks?: TestCase['functionMocks'] }
  | { rules: string; cases: TestCase[] }
  | { unprobeable: string };

export const FS_BASE_CASE: Omit<TestCase, 'description'> = {
  expectation: 'ALLOW',
  method: 'get',
  path: 'probe/x',
  auth: { uid: 'u', token: { admin: true } },
  data: { a: 1, b: 2, s: 'str' },
  resource: { a: 1, b: 2, s: 'str' },
};

/** Fixed instant shared by local capability and production acceptance probes. */
export const FIRESTORE_PROBE_TIME = '2024-01-01T00:00:00Z';

/**
 * Resolve an {@link FsProbe} into the (rules, cases) pair a rules-test
 * backend executes — local simulator or production Rules Test API alike.
 * Exported (issue #185 step 5) so the production acceptance probe
 * (rules-language-acceptance.ts) builds the EXACT same request the
 * capability probe runs against the local simulator; only the backend
 * differs.
 */
export function resolveFsProbe(probe: FsProbe): { rules: string; cases: TestCase[] } | { unprobeable: string } {
  if ('unprobeable' in probe) return probe;
  if ('rules' in probe) return { rules: probe.rules, cases: probe.cases };
  const rules = FS_RULESET(probe.expr, probe.method === 'create' || probe.method === 'update' || probe.method === 'delete' ? 'write' : 'read');
  const cases: TestCase[] = [{ description: 'probe', ...FS_BASE_CASE, method: probe.method ?? 'get', functionMocks: probe.withMocks }];
  return { rules, cases };
}

function fsRunResolved(resolved: ReturnType<typeof resolveFsProbe>): { classification: Classification; detail: string; evaluationAgreement?: boolean } {
  if ('unprobeable' in resolved) return { classification: 'unprobeable', detail: resolved.unprobeable };
  const { rules, cases } = resolved;
  let res;
  try {
    res = fsSim.simulate(rules, cases);
  } catch (e) {
    return { classification: 'error', detail: `threw: ${(e as Error).message}` };
  }
  if (!res.success) return { classification: 'error', detail: `${res.error.code}: ${res.error.message}` };
  const r = res.data.results[0];
  if (!r) return { classification: 'error', detail: 'no result row' };
  if (r.decision === 'UNSUPPORTED') return { classification: 'unsupported', detail: fsUnsupportedReason(r) };
  const errEntry = r.trace.find((t) => t.verdict === 'ERROR');
  if (errEntry && r.decision !== 'ALLOW') return { classification: 'error', detail: `eval error: ${errEntry.message ?? ''}` };
  const evaluationAgreement = res.data.results.length === cases.length &&
    res.data.results.every((result, index) => result.decision === cases[index]?.expectation);
  return { classification: 'implemented', detail: `decision ${r.decision}`, evaluationAgreement };
}

function fsUnsupportedReason(r: { trace: Array<{ verdict: string; message?: string }> }): string {
  const u = r.trace.find((t) => t.verdict === 'UNSUPPORTED');
  return u?.message ?? 'evaluator abstained (UNSUPPORTED)';
}

/** Expression probes keyed by construct id, for the expression-level kinds. */
const FS_EXPR: Record<string, FsProbe> = {
  // Functions — builtins
  'firestore.function.get': { expr: "get(/databases/$(database)/documents/other/x).data.k == 'v'", withMocks: [{ function: 'get', path: 'other/x', result: { k: 'v' } }] },
  'firestore.function.exists': { expr: 'exists(/databases/$(database)/documents/other/x) == true', withMocks: [{ function: 'exists', path: 'other/x', result: true }] },
  'firestore.function.getAfter': { expr: 'getAfter(request.path).data.a == request.resource.data.a', method: 'create' },
  'firestore.function.existsAfter': { expr: 'existsAfter(request.path) == true', method: 'create' },
  'firestore.function.debug': { expr: 'debug(true) == true' },
  // Namespace functions
  'firestore.function.math.abs': { expr: 'math.abs(-1) == 1' },
  'firestore.function.math.ceil': { expr: 'math.ceil(1.2) == 2' },
  'firestore.function.math.floor': { expr: 'math.floor(1.8) == 1' },
  'firestore.function.math.round': { expr: 'math.round(1.5) == 2' },
  'firestore.function.math.sqrt': { expr: 'math.sqrt(4) == 2' },
  'firestore.function.math.pow': { expr: 'math.pow(2, 3) == 8' },
  'firestore.function.math.isInfinite': { expr: 'math.isInfinite(1.0) == false' },
  'firestore.function.math.isNaN': { expr: 'math.isNaN(0.0) == false' },
  'firestore.function.timestamp.date': { expr: 'timestamp.date(2020, 1, 1).year() == 2020' },
  'firestore.function.timestamp.value': { expr: 'timestamp.value(0).toMillis() == 0' },
  'firestore.function.duration.value': { expr: "duration.value(1, 's').seconds() == 1" },
  'firestore.function.duration.time': { expr: 'duration.time(0, 0, 1, 0).seconds() == 1' },
  'firestore.function.duration.abs': { expr: "duration.abs(duration.value(-1, 's')).seconds() == 1" },
  'firestore.function.latlng.value': { expr: 'latlng.value(0.0, 0.0).latitude() == 0.0' },
  'firestore.function.hashing.md5': { expr: "hashing.md5('x').size() >= 0" },
  'firestore.function.hashing.sha256': { expr: "hashing.sha256('x').size() >= 0" },
  'firestore.function.hashing.crc32': { expr: "hashing.crc32('x').size() >= 0" },
  'firestore.function.hashing.crc32c': { expr: "hashing.crc32c('x').size() >= 0" },
  // Casts
  'firestore.function.cast.string': { expr: "string(1) == '1'" },
  'firestore.function.cast.int': { expr: 'int(5) == 5' },
  'firestore.function.cast.float': { expr: 'float(1) == float(1)' },
  'firestore.function.cast.bool': { expr: 'bool(true) == true' },
  'firestore.function.cast.path': { expr: "path('/databases/x/documents/a/b') == path('/databases/x/documents/a/b')" },
  // String methods
  'firestore.method.string.matches': { expr: "'abc'.matches('a.*') == true" },
  'firestore.method.string.lower': { expr: "'AB'.lower() == 'ab'" },
  'firestore.method.string.upper': { expr: "'ab'.upper() == 'AB'" },
  'firestore.method.string.trim': { expr: "'  a  '.trim() == 'a'" },
  'firestore.method.string.size': { expr: "'abc'.size() == 3" },
  'firestore.method.string.split': { expr: "'a,b'.split(',').size() == 2" },
  'firestore.method.string.replace': { expr: "'ab'.replace('a', 'c') == 'cb'" },
  'firestore.method.string.toUtf8': { expr: "'a'.toUtf8().size() >= 1" },
  // List methods
  'firestore.method.list.hasAll': { expr: '[1, 2].hasAll([1])' },
  'firestore.method.list.hasAny': { expr: '[1, 2].hasAny([1])' },
  'firestore.method.list.hasOnly': { expr: '[1].hasOnly([1, 2])' },
  'firestore.method.list.size': { expr: '[1, 2].size() == 2' },
  'firestore.method.list.toSet': { expr: '[1, 2].toSet().size() == 2' },
  'firestore.method.list.concat': { expr: '[1].concat([2]).size() == 2' },
  'firestore.method.list.removeAll': { expr: '[1, 2].removeAll([1]).size() == 1' },
  'firestore.method.list.join': { expr: "['a', 'b'].join(',') == 'a,b'" },
  // Map methods
  'firestore.method.map.keys': { expr: "{'a': 1}.keys().hasAll(['a'])" },
  'firestore.method.map.values': { expr: "{'a': 1}.values().hasAll([1])" },
  'firestore.method.map.size': { expr: "{'a': 1}.size() == 1" },
  'firestore.method.map.get': { expr: "{'a': 1}.get('a', 0) == 1" },
  'firestore.method.map.hasAll': { expr: "{'a': 1}.hasAll(['a'])" },
  'firestore.method.map.hasAny': { expr: "{'a': 1}.hasAny(['a'])" },
  'firestore.method.map.hasOnly': { expr: "{'a': 1}.hasOnly(['a'])" },
  'firestore.method.map.diff': { expr: "{'a': 1}.diff({'a': 1}).affectedKeys().size() == 0" },
  // MapDiff methods
  'firestore.method.mapdiff.addedKeys': { expr: "{'a': 1, 'b': 2}.diff({'a': 1}).addedKeys().hasAll(['b'])" },
  'firestore.method.mapdiff.removedKeys': { expr: "{'a': 1}.diff({'a': 1, 'b': 2}).removedKeys().hasAll(['b'])" },
  'firestore.method.mapdiff.changedKeys': { expr: "{'a': 2}.diff({'a': 1}).changedKeys().hasAll(['a'])" },
  'firestore.method.mapdiff.affectedKeys': { expr: "{'a': 2}.diff({'a': 1}).affectedKeys().hasAll(['a'])" },
  'firestore.method.mapdiff.unchangedKeys': { expr: "{'a': 1}.diff({'a': 1}).unchangedKeys().hasAll(['a'])" },
  // Set methods
  'firestore.method.set.difference': { expr: '[1, 2].toSet().difference([1].toSet()).size() == 1' },
  'firestore.method.set.union': { expr: '[1].toSet().union([2].toSet()).size() == 2' },
  'firestore.method.set.intersection': { expr: '[1, 2].toSet().intersection([2].toSet()).size() == 1' },
  'firestore.method.set.hasAll': { expr: '[1, 2].toSet().hasAll([1])' },
  'firestore.method.set.hasAny': { expr: '[1, 2].toSet().hasAny([1])' },
  'firestore.method.set.hasOnly': { expr: '[1].toSet().hasOnly([1, 2])' },
  'firestore.method.set.size': { expr: '[1, 2].toSet().size() == 2' },
  // Bytes methods (via hashing output)
  'firestore.method.bytes.size': { expr: "hashing.crc32('x').size() >= 0" },
  'firestore.method.bytes.toBase64': { expr: "hashing.crc32('x').toBase64().size() >= 0" },
  'firestore.method.bytes.toHexString': { expr: "hashing.crc32('x').toHexString().size() >= 0" },
  // Path methods
  'firestore.method.path.bind': { expr: "path('/databases/d/documents/a/{id}').bind({'id': 'b'}) == path('/databases/d/documents/a/b')" },
  // Timestamp methods (request.time is a timestamp)
  'firestore.method.timestamp.year': { expr: 'request.time.year() >= 1970' },
  'firestore.method.timestamp.month': { expr: 'request.time.month() >= 1' },
  'firestore.method.timestamp.day': { expr: 'request.time.day() >= 1' },
  'firestore.method.timestamp.hours': { expr: 'request.time.hours() >= 0' },
  'firestore.method.timestamp.minutes': { expr: 'request.time.minutes() >= 0' },
  'firestore.method.timestamp.seconds': { expr: 'request.time.seconds() >= 0' },
  'firestore.method.timestamp.nanos': { expr: 'request.time.nanos() >= 0' },
  'firestore.method.timestamp.dayOfWeek': { expr: 'request.time.dayOfWeek() >= 1' },
  'firestore.method.timestamp.dayOfYear': { expr: 'request.time.dayOfYear() >= 1' },
  'firestore.method.timestamp.date': { expr: 'request.time.date() == request.time.date()' },
  'firestore.method.timestamp.time': { expr: 'request.time.time() == request.time.time()' },
  'firestore.method.timestamp.toMillis': { expr: 'request.time.toMillis() >= 0' },
  // Duration methods
  'firestore.method.duration.seconds': { expr: "duration.value(1, 's').seconds() == 1" },
  'firestore.method.duration.nanos': { expr: "duration.value(1, 's').nanos() >= 0" },
  // LatLng methods
  'firestore.method.latlng.latitude': { expr: 'latlng.value(1.0, 2.0).latitude() == 1.0' },
  'firestore.method.latlng.longitude': { expr: 'latlng.value(1.0, 2.0).longitude() == 2.0' },
  'firestore.method.latlng.distance': { expr: 'latlng.value(0.0, 0.0).distance(latlng.value(0.0, 0.0)) >= 0' },
  // Operators
  'firestore.operator.eq': { expr: '1 == 1' },
  'firestore.operator.neq': { expr: '1 != 2' },
  'firestore.operator.lt': { expr: '1 < 2' },
  'firestore.operator.gt': { expr: '2 > 1' },
  'firestore.operator.lte': { expr: '1 <= 1' },
  'firestore.operator.gte': { expr: '1 >= 1' },
  'firestore.operator.add': { expr: '1 + 1 == 2' },
  'firestore.operator.sub': { expr: '2 - 1 == 1' },
  'firestore.operator.mul': { expr: '2 * 3 == 6' },
  'firestore.operator.div': { expr: '6 / 2 == 3' },
  'firestore.operator.mod': { expr: '5 % 2 == 1' },
  'firestore.operator.and': { expr: 'true && true' },
  'firestore.operator.or': { expr: 'false || true' },
  'firestore.operator.not': { expr: '!false' },
  'firestore.operator.ternary': { expr: '(true ? 1 : 0) == 1' },
  'firestore.operator.in': { expr: '1 in [1, 2]' },
  'firestore.operator.is': { expr: '(1 is int) == true' },
  'firestore.operator.unary-minus': { expr: '-1 < 0' },
  'firestore.operator.member': { expr: 'request.resource.data.a == request.resource.data.a' },
  'firestore.operator.index': { expr: '[10, 20][0] == 10' },
  'firestore.operator.slice': { expr: '[1, 2, 3][0:2].size() == 2' },
};

export function fsProbeFor(c: LanguageConstruct): FsProbe {
  if (c.id in FS_EXPR) return FS_EXPR[c.id];
  // Bindings — a tautology that forces the binding to resolve.
  if (c.kind === 'binding') {
    const name = c.id.slice('firestore.binding.'.length);
    if (name === 'path-variable') return { expr: 'id == id' };
    if (name === 'request.query') return { expr: 'request.method == request.method' }; // query only bound on list; probe method availability instead
    return { expr: `${name} == ${name}` };
  }
  // Rule-kinds — allow verbs and structural forms.
  if (c.kind === 'rule-kind') {
    const name = c.id.slice('firestore.rule-kind.'.length);
    const allowVerbs: Record<string, TestCase['method']> = {
      'allow-read': 'get', 'allow-get': 'get', 'allow-list': 'list',
      'allow-create': 'create', 'allow-update': 'update', 'allow-delete': 'delete',
    };
    if (name === 'allow-write') {
      return { rules: FS_RULESET('true', 'write'), cases: [{ description: 'probe', ...FS_BASE_CASE, method: 'create' }] };
    }
    if (name in allowVerbs) {
      const verb = name === 'allow-list' ? 'list' : name.slice('allow-'.length);
      return { rules: FS_RULESET('true', verb), cases: [{ description: 'probe', ...FS_BASE_CASE, method: allowVerbs[name] }] };
    }
    if (name === 'match') return { expr: 'true' }; // the standard ruleset is one match block
    if (name === 'rules_version') return { expr: 'true' }; // ruleset declares rules_version = '2'
    if (name === 'function') {
      return { rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function ok() { return true; }
    match /probe/{id} { allow read: if ok(); }
  }
}`, cases: [{ description: 'probe', ...FS_BASE_CASE }] };
    }
    if (name === 'let') {
      return { rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function ok() { let x = true; return x; }
    match /probe/{id} { allow read: if ok(); }
  }
}`, cases: [{ description: 'probe', ...FS_BASE_CASE }] };
    }
    if (name === 'import') {
      return { unprobeable: "the `import`/2+modules form requires module resolution (resolveModules) before simulation; the SimulateFirestoreRulesHandler evaluates already-resolved source only." };
    }
  }
  // Semantics.
  if (c.kind === 'semantic') {
    const name = c.id.slice('firestore.semantic.'.length);
    if (name === 'recursive-wildcard') {
      return { rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /probe/{rest=**} { allow read: if true; }
  }
}`, cases: [{ description: 'probe', ...FS_BASE_CASE, path: 'probe/a/b/c' }] };
    }
    if (name === 'hierarchical-match-cascade') {
      return { rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /probe/{id} {
      match /sub/{sid} { allow read: if true; }
    }
  }
}`, cases: [{ description: 'probe', ...FS_BASE_CASE, path: 'probe/x/sub/y' }] };
    }
    if (name === 'error-absorption-or') return { expr: 'true || (request.resource.data.missing.deep == 1)' };
    if (name === 'error-absorption-and') return { expr: '!(false && (request.resource.data.missing.deep == 1))' };
    if (name === 'get-budget') {
      return { unprobeable: 'the get() budget (cap 10 per evaluation) is a resource-limit semantic, not expressible as a single-expression micro-scenario.' };
    }
    if (name === 'type-dispatch') {
      return { unprobeable: 'type-based method dispatch is a meta-semantic exercised by every method call; it has no standalone micro-scenario of its own.' };
    }
  }
  return { unprobeable: `no generator for construct kind ${c.kind}` };
}

/** Resolve the canonical Firestore construct probe used by both backends. */
export function resolveFirestoreConstructProbe(
  c: LanguageConstruct,
): { rules: string; cases: TestCase[] } | { unprobeable: string } {
  const resolved = resolveFsProbe(fsProbeFor(c));
  if ('unprobeable' in resolved) return resolved;
  return {
    rules: resolved.rules,
    cases: resolved.cases.map((testCase) =>
      testCase.requestTime ? testCase : { ...testCase, requestTime: FIRESTORE_PROBE_TIME }),
  };
}

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
    let r: { classification: Classification; detail: string; evaluationAgreement?: boolean };
    let probeDigest: ConstructCapability['probeDigest'];
    if (engine === 'firestore') {
      const resolved = resolveFirestoreConstructProbe(c);
      r = fsRunResolved(resolved);
      if (!('unprobeable' in resolved)) {
        probeDigest = firestoreRulesTestInputDigest(resolved.rules, resolved.cases);
      }
    }
    else if (engine === 'storage') r = stRun(stProbeFor(c));
    else r = rtRun(rtProbeFor(c));
    out.push({
      id: c.id, kind: c.kind, classification: r.classification, detail: r.detail,
      ...(probeDigest ? { probeDigest } : {}),
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
      'DRAFT (issue #185 step 3). Language coverage = constructs the simulator EVALUATES / auto-probeable constructs (implemented + unsupported). `error` marks malformed micro-scenarios; `unprobeable` marks constructs no micro-scenario can auto-generate (behavioral semantics, module resolution, unmodeled fields). Not yet wired into the ratchet (step 4).',
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
