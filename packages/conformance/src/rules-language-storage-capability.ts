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
        resource: input.request.resource,
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
  const evaluationAgreement = construct ? EXPECTS_DENY.has(construct.id) : undefined;
  return {
    classification: 'implemented',
    detail: `DENY: ${reason}`,
    ...(probeDigest ? { probeDigest } : {}),
    ...(evaluationAgreement !== undefined ? { evaluationAgreement } : {}),
  };
}

const ST_EXPR: Record<string, StProbe> = {
  'storage.function.timestamp.date': { expr: 'request.time < timestamp.date(2999, 1, 1)' },
  'storage.function.timestamp.value': { expr: 'request.time < timestamp.value(99999999999999)' },
  'storage.function.duration.value': { expr: "request.time < resource.timeCreated + duration.value(99999, 'd')" },
  'storage.function.firestore.get': { expr: "firestore.get(/databases/(default)/documents/u/x).data.k == 'v'" },
  'storage.function.firestore.exists': { expr: 'firestore.exists(/databases/(default)/documents/u/x)' },
  'storage.method.string.matches': { expr: "request.resource.contentType.matches('text/.*')" },
  'storage.method.size': { expr: 'request.resource.contentType.size() > 0' },
  'storage.method.string.split': { expr: "request.resource.contentType.split('/')[0] == 'text'" },
  'storage.method.map.keys': { expr: "request.resource.metadata.keys().hasAll(['owner'])" },
  'storage.method.map.get': { expr: "request.resource.metadata.get('owner', '') == 'u'" },
  'storage.method.set.hasAll': { expr: "request.resource.metadata.keys().hasAll(['owner'])" },
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
