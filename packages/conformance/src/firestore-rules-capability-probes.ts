import type { TestCase } from '../../pyric/src/rules/test/spec.ts';
import type { LanguageConstruct } from '../rules-language/load.ts';

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
  | { expr: string; method?: TestCase['method']; query?: TestCase['query']; withMocks?: TestCase['functionMocks'] }
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
  const cases: TestCase[] = [{
    description: 'probe', ...FS_BASE_CASE, method: probe.method ?? 'get',
    functionMocks: probe.withMocks, query: probe.query,
  }];
  return { rules, cases };
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
    if (name === 'request.query') return {
      expr: 'request.query.limit == 10', method: 'list', query: { limit: 10 },
    };
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
    if (name === 'error-absorption-or') return { expr: '(request.resource.data.missing.deep == 1) || true' };
    if (name === 'error-absorption-and') return { expr: '!((request.resource.data.missing.deep == 1) && false)' };
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
