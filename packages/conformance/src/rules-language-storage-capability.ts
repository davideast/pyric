import {
  parseStorageRules,
  type EvaluationInput,
  type FirestoreLookup,
} from '../../../packages/pyric/src/storage/sandbox/rules.ts';
import { evaluateStorageRules } from '../../../packages/pyric/src/storage/sandbox/rules-evaluator.ts';
import type { StorageTestCase, StorageFunctionMock } from '../../../packages/pyric/src/rules/test/spec.ts';
import type { LanguageConstruct } from '../rules-language/load.ts';
import type { Classification } from './rules-language-capability.ts';
import { storageRulesTestInputDigest, type StorageScenarioInputDigest } from './storage-rules-input-digest.ts';

export const ST_RULESET = (expr: string, verb = 'read') => `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /probe/{id} {
      allow ${verb}: if ${expr};
    }
  }
}`;

export type StProbe =
  | { expr: string; method?: EvaluationInput['request']['method'] }
  | { rules: string; input: EvaluationInput }
  | { unprobeable: string };

export const ST_INPUT: EvaluationInput = {
  request: {
    auth: { uid: 'u', token: { admin: true } },
    method: 'read',
    path: '/b/demo-pyric.appspot.com/o/probe/x',
    resource: { size: 10, contentType: 'text/plain', metadata: { owner: 'u' } },
  },
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

export const EXPECTS_DENY = new Set(['storage.semantic.deny-by-default']);

function storageMethodToTestMethod(
  method: EvaluationInput['request']['method'],
): 'get' | 'list' | 'create' | 'update' | 'delete' {
  if (method === 'read') return 'get';
  if (method === 'write') return 'create';
  return method;
}

const ST_FUNCTION_MOCKS: Record<string, StorageFunctionMock[]> = {
  'storage.function.firestore.get': [{ function: 'get', path: 'u/x', result: { k: 'v' } }],
  'storage.function.firestore.exists': [{ function: 'exists', path: 'u/x', result: true }],
};

/** The Rules Test API case shape of `request.resource`. The capability probes
 *  never set a field to null, so only present, non-null fields are sent. */
function wireRequestResource(resource: EvaluationInput['request']['resource']): StorageTestCase['resource'] {
  if (!resource) return undefined;
  return Object.fromEntries(Object.entries(resource).filter(([, value]) => value !== null && value !== undefined));
}

export function storageRequest(
  c: LanguageConstruct,
): { rules: string; cases: StorageTestCase[] } | { unprobeable: string } {
  const resolved = resolveStProbe(stProbeFor(c));
  if ('unprobeable' in resolved) return resolved;
  const { rules, input } = resolved;
  const expectation = EXPECTS_DENY.has(c.id) ? 'DENY' : 'ALLOW';
  const functionMocks = ST_FUNCTION_MOCKS[c.id];
  return {
    rules,
    cases: [
      {
        description: 'probe',
        expectation,
        method: storageMethodToTestMethod(input.request.method),
        path: input.request.path,
        auth: input.request.auth ?? null,
        resource: wireRequestResource(input.request.resource),
        existingResource: input.resource,
        requestTime: '2024-01-01T00:00:00Z',
        ...(functionMocks ? { functionMocks } : {}),
      },
    ],
  };
}

export function resolveStProbe(
  probe: StProbe,
): { rules: string; input: EvaluationInput } | { unprobeable: string } {
  if ('unprobeable' in probe) return probe;
  if ('rules' in probe) return { rules: probe.rules, input: probe.input };
  const verb = probe.method ?? 'read';
  return {
    rules: ST_RULESET(probe.expr, verb),
    input: { ...ST_INPUT, request: { ...ST_INPUT.request, method: verb } },
  };
}

export function stRun(
  probe: StProbe,
  construct?: LanguageConstruct,
): {
  classification: Classification;
  detail: string;
  probeDigest?: StorageScenarioInputDigest;
  evaluationAgreement?: boolean;
} {
  const resolved = resolveStProbe(probe);
  if ('unprobeable' in resolved) {
    return { classification: 'unprobeable', detail: resolved.unprobeable };
  }
  const req = construct ? storageRequest(construct) : undefined;
  const probeDigest = req && !('unprobeable' in req) ? storageRulesTestInputDigest(req.rules, req.cases) : undefined;

  let parsed;
  try {
    parsed = parseStorageRules(resolved.rules);
  } catch (error) {
    return { classification: 'error', detail: `parse threw: ${(error as Error).message}`, ...(probeDigest ? { probeDigest } : {}) };
  }
  const mocks = construct ? ST_FUNCTION_MOCKS[construct.id] : undefined;
  const firestoreLookup: FirestoreLookup | undefined = mocks && mocks.length > 0 ? {
    get: (path) => {
      const m = mocks.find((mock) => mock.function === 'get' && (path === mock.path || path.endsWith(mock.path)));
      return m && typeof m.result === 'object' && m.result !== null ? m.result as Record<string, unknown> : null;
    },
    exists: (path) => {
      const m = mocks.find((mock) => mock.function === 'exists' && (path === mock.path || path.endsWith(mock.path)));
      return Boolean(m && m.result === true);
    },
  } : undefined;
  let result;
  try {
    result = evaluateStorageRules(parsed, resolved.input, new Date('2024-01-01T00:00:00Z'), firestoreLookup);
  } catch (error) {
    return { classification: 'error', detail: `eval threw: ${(error as Error).message}`, ...(probeDigest ? { probeDigest } : {}) };
  }
  if (result.allowed) {
    const evaluationAgreement = construct ? !EXPECTS_DENY.has(construct.id) : undefined;
    return {
      classification: 'implemented',
      detail: 'ALLOW',
      ...(probeDigest ? { probeDigest } : {}),
      ...(evaluationAgreement !== undefined ? { evaluationAgreement } : {}),
    };
  }
  const reason = result.reasons.join('; ');
  if (/unsupported|unknown|not supported|no firestore lookup|cannot resolve/i.test(reason)) {
    return { classification: 'unsupported', detail: reason, ...(probeDigest ? { probeDigest } : {}) };
  }
  // A rule that denied with an evaluation error, not a false condition or an
  // unmatched path, is a local rejection, as a Firestore probe whose trace
  // carries an ERROR is.
  const evaluationError = result.reasons.find((r) => !/: condition false$/.test(r) && !/^no rule matches /.test(r));
  if (evaluationError !== undefined) {
    return { classification: 'error', detail: `eval error: ${evaluationError}`, ...(probeDigest ? { probeDigest } : {}) };
  }
  const evaluationAgreement = construct ? EXPECTS_DENY.has(construct.id) : undefined;
  return {
    classification: 'implemented',
    detail: `DENY: ${reason}`,
    ...(probeDigest ? { probeDigest } : {}),
    ...(evaluationAgreement !== undefined ? { evaluationAgreement } : {}),
  };
}

const ST_EXPR: Record<string, StProbe> = {
  'storage.function.cast.string': { expr: "string(1) == '1'" },
  'storage.function.cast.int': { expr: "int('1') == 1" },
  'storage.function.cast.float': { expr: "float('1.5') == 1.5" },
  'storage.function.cast.bool': { expr: "bool('true') == true" },
  'storage.function.cast.path': { expr: "path('/a/b') == /a/b" },
  'storage.function.timestamp.date': { expr: 'request.time < timestamp.date(2999, 1, 1)' },
  'storage.function.timestamp.value': { expr: 'request.time < timestamp.value(99999999999999)' },
  'storage.function.duration.value': { expr: "request.time < resource.timeCreated + duration.value(99999, 'd')" },
  'storage.function.duration.time': { expr: "duration.time(0, 0, 1, 0) == duration.value(1, 's')" },
  'storage.function.duration.abs': { expr: "duration.abs(duration.value(-1, 's')) == duration.value(1, 's')" },
  'storage.function.firestore.get': { expr: "firestore.get(/databases/(default)/documents/u/x).data.k == 'v'" },
  'storage.function.firestore.exists': { expr: 'firestore.exists(/databases/(default)/documents/u/x)' },
  'storage.function.math.abs': { expr: 'math.abs(-1) == 1' },
  'storage.function.math.ceil': { expr: 'math.ceil(1.2) == 2' },
  'storage.function.math.floor': { expr: 'math.floor(1.8) == 1' },
  'storage.function.math.round': { expr: 'math.round(1.5) == 2' },
  'storage.function.math.sqrt': { expr: 'math.sqrt(4) == 2' },
  'storage.function.math.pow': { expr: 'math.pow(2, 3) == 8' },
  'storage.function.math.isInfinite': { expr: 'math.isInfinite(1.0) == false' },
  'storage.function.math.isNaN': { expr: 'math.isNaN(0.0) == false' },
  'storage.function.hashing.md5': { expr: "hashing.md5('x').size() == 16" },
  'storage.function.hashing.sha256': { expr: "hashing.sha256('x').size() == 32" },
  'storage.function.hashing.crc32': { expr: "hashing.crc32('x').size() == 4" },
  'storage.function.hashing.crc32c': { expr: "hashing.crc32c('x').size() == 4" },
  'storage.function.latlng.value': { expr: 'latlng.value(1.0, 2.0) == latlng.value(1.0, 2.0)' },
  'storage.method.string.matches': { expr: "request.resource.contentType.matches('text/.*')" },
  'storage.method.size': { expr: 'request.resource.contentType.size() > 0' },
  'storage.method.string.split': { expr: "request.resource.contentType.split('/')[0] == 'text'" },
  'storage.method.string.lower': { expr: "'ABC'.lower() == 'abc'" },
  'storage.method.string.upper': { expr: "'abc'.upper() == 'ABC'" },
  'storage.method.string.trim': { expr: "' a '.trim() == 'a'" },
  'storage.method.string.replace': { expr: "'a-b'.replace('-', '_') == 'a_b'" },
  'storage.method.string.toUtf8': { expr: "'ab'.toUtf8().size() == 2" },
  'storage.method.bytes.toBase64': { expr: "b'a'.toBase64() == 'YQ=='" },
  'storage.method.bytes.toHexString': { expr: "b'a'.toHexString() == '61'" },
  'storage.method.timestamp.date': { expr: 'request.time.date() == timestamp.date(2024, 1, 1)' },
  'storage.method.timestamp.year': { expr: 'request.time.year() == 2024' },
  'storage.method.timestamp.month': { expr: 'request.time.month() == 1' },
  'storage.method.timestamp.day': { expr: 'request.time.day() == 1' },
  'storage.method.timestamp.hours': { expr: 'request.time.hours() == 0' },
  'storage.method.timestamp.minutes': { expr: 'request.time.minutes() == 0' },
  'storage.method.timestamp.seconds': { expr: 'request.time.seconds() == 0' },
  'storage.method.timestamp.nanos': { expr: 'request.time.nanos() == 0' },
  'storage.method.timestamp.dayOfWeek': { expr: 'request.time.dayOfWeek() == 1' },
  'storage.method.timestamp.dayOfYear': { expr: 'request.time.dayOfYear() == 1' },
  'storage.method.timestamp.time': { expr: "request.time.time() == duration.value(0, 's')" },
  'storage.method.timestamp.toMillis': { expr: 'request.time.toMillis() == 1704067200000' },
  'storage.method.duration.seconds': { expr: "duration.value(5, 's').seconds() == 5" },
  'storage.method.duration.nanos': { expr: "duration.value(5, 's').nanos() == 0" },
  'storage.method.map.keys': { expr: "request.resource.metadata.keys().hasAll(['owner'])" },
  'storage.method.map.values': { expr: "request.resource.metadata.values() == ['u']" },
  'storage.method.map.get': { expr: "request.resource.metadata.get('owner', '') == 'u'" },
  'storage.method.map.diff': { expr: 'request.resource.metadata.diff(resource.metadata).unchangedKeys().size() == 1' },
  'storage.method.mapdiff.addedKeys': { expr: "{'a': 1, 'b': 2}.diff({'a': 1}).addedKeys() == ['b'].toSet()" },
  'storage.method.mapdiff.removedKeys': { expr: "{'a': 1}.diff({'a': 1, 'b': 2}).removedKeys() == ['b'].toSet()" },
  'storage.method.mapdiff.changedKeys': { expr: "{'a': 2}.diff({'a': 1}).changedKeys() == ['a'].toSet()" },
  'storage.method.mapdiff.unchangedKeys': { expr: "{'a': 1}.diff({'a': 1}).unchangedKeys() == ['a'].toSet()" },
  'storage.method.mapdiff.affectedKeys': { expr: "{'a': 2}.diff({'a': 1}).affectedKeys() == ['a'].toSet()" },
  'storage.method.set.hasAll': { expr: "request.resource.metadata.keys().hasAll(['owner'])" },
  'storage.method.set.hasAny': { expr: "['owner'].toSet().hasAny(['owner', 'z'])" },
  'storage.method.set.hasOnly': { expr: "['owner'].toSet().hasOnly(['owner', 'z'])" },
  'storage.method.set.difference': { expr: "['a', 'b'].toSet().difference(['b'].toSet()) == ['a'].toSet()" },
  'storage.method.set.intersection': { expr: "['a', 'b'].toSet().intersection(['b', 'c'].toSet()) == ['b'].toSet()" },
  'storage.method.set.union': { expr: "['a'].toSet().union(['b'].toSet()) == ['a', 'b'].toSet()" },
  'storage.method.list.toSet': { expr: "request.resource.metadata.keys().toSet() == ['owner'].toSet()" },
  'storage.method.list.join': { expr: "request.resource.metadata.keys().join(',') == 'owner'" },
  'storage.method.list.hasAny': { expr: "request.resource.metadata.keys().hasAny(['owner', 'z'])" },
  'storage.method.list.hasOnly': { expr: "request.resource.metadata.keys().hasOnly(['owner', 'z'])" },
  'storage.method.list.concat': { expr: "request.resource.metadata.keys().concat(['z']) == ['owner', 'z']" },
  'storage.method.list.removeAll': { expr: "request.resource.metadata.keys().removeAll(['owner']) == []" },
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
  'storage.operator.mod': { expr: 'request.resource.size % 3 == 1' },
  'storage.operator.and': { expr: 'request.auth != null && request.resource.size == 10' },
  'storage.operator.or': { expr: 'request.auth == null || request.resource.size == 10' },
  'storage.operator.not': { expr: '!(request.auth == null)' },
  'storage.operator.member': { expr: 'request.resource.metadata.owner == request.auth.uid' },
  'storage.operator.index': { expr: "request.resource.metadata['owner'] == request.auth.uid" },
  'storage.operator.slice': { expr: "request.resource.contentType[0:4] == 'text'" },
  'storage.operator.is': { expr: 'request.resource.size is int' },
  'storage.operator.in': { expr: "'owner' in request.resource.metadata" },
  'storage.operator.ternary': { expr: 'request.resource.size == 10 ? true : false' },
  'storage.operator.unary-minus': { expr: '-request.resource.size == -10' },
  'storage.binding.resource.name': { expr: "resource.name.matches('probe/.*')" },
  'storage.binding.request.resource.name': {
    rules: ST_RULESET("request.resource.name.matches('probe/.*')", 'create'),
    input: {
      request: { ...ST_INPUT.request, method: 'create', resource: { ...ST_INPUT.request.resource!, name: 'probe/x' } },
      resource: null,
    },
  },
  'storage.binding.resource.bucket': { expr: 'resource.bucket == resource.bucket' },
  'storage.binding.resource.generation': { expr: 'resource.generation == 1' },
  'storage.binding.resource.metageneration': { expr: 'resource.metageneration == 1' },
  'storage.binding.resource.timeCreated': { expr: 'resource.timeCreated < resource.updated' },
  'storage.binding.resource.updated': { expr: 'resource.updated > resource.timeCreated' },
};

export function stProbeFor(construct: LanguageConstruct): StProbe {
  if (construct.id in ST_EXPR) return ST_EXPR[construct.id];
  if (construct.kind === 'binding') {
    const name = construct.id.slice('storage.binding.'.length);
    if (name === 'path-variable') return { expr: 'id == id' };
    if (construct.note) {
      return {
        unprobeable: `${name} is unmodeled by the standalone evaluator (reads undefined); a micro-scenario cannot distinguish unimplemented from implemented-but-absent. ${construct.note}`,
      };
    }
    if (name === 'request.method') return { expr: "request.method == 'get' || request.method == 'read'" };
    if (name === 'request.path') return { expr: 'request.path == request.path' };
    if (name === 'request.time') return { expr: 'request.time == request.time' };
    return { expr: `${name} == ${name}` };
  }
  if (construct.kind === 'rule-kind') {
    const name = construct.id.slice('storage.rule-kind.'.length);
    const verbMap: Record<string, EvaluationInput['request']['method']> = {
      'allow-read': 'get', 'allow-get': 'get', 'allow-list': 'list',
      'allow-write': 'create', 'allow-create': 'create',
      'allow-update': 'update', 'allow-delete': 'delete',
    };
    if (name in verbMap) {
      return {
        rules: ST_RULESET('true', name.slice('allow-'.length)),
        input: { ...ST_INPUT, request: { ...ST_INPUT.request, method: verbMap[name] } },
      };
    }
    if (name === 'match' || name === 'rules_version') return { expr: 'true' };
    if (name === 'function') {
      return { rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function ok() { return true; }
    match /probe/{id} { allow read: if ok(); }
  }
}`, input: ST_INPUT };
    }
    if (name === 'let') {
      return { rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function ok() { let x = true; return x; }
    match /probe/{id} { allow read: if ok(); }
  }
}`, input: ST_INPUT };
    }
  }
  if (construct.kind === 'semantic') {
    const name = construct.id.slice('storage.semantic.'.length);
    if (name === 'read-umbrella' || name === 'write-umbrella') {
      const read = name === 'read-umbrella';
      return {
        rules: ST_RULESET('true', read ? 'read' : 'write'),
        input: { ...ST_INPUT, request: { ...ST_INPUT.request, method: read ? 'get' : 'create' } },
      };
    }
    if (name === 'recursive-wildcard') {
      return { rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /probe/{allPaths=**} { allow read: if true; }
  }
}`, input: {
        ...ST_INPUT,
        request: { ...ST_INPUT.request, method: 'get', path: '/b/demo-pyric.appspot.com/o/probe/a/b/c' },
      } };
    }
    if (name === 'deny-by-default') {
      return { rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /nothing/{id} { allow read: if true; }
  }
}`, input: ST_INPUT };
    }
  }
  return { unprobeable: `no generator for construct kind ${construct.kind}` };
}
