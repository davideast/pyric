import { toOperationRecord } from '../../src/sandbox/operation-record.js';
import type { SandboxEvent } from '../../src/sandbox/types/events.js';
import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { setRules } from 'pyric/sandbox/firestore';
import { getFirestore, collection, query, where, limit, getDocs, onSnapshot } from '../../src/firestore/index.js';
import { LocalEnvironment } from '../../src/firestore/sandbox/local-environment.js';
import type { RequestEvent } from '../../src/sandbox/types/events.js';

const path = 'clubs/demo/seasons/2026/meets';
const membership = "resource.data.visibility == 'public' && resource.data.status in ['scheduled', 'changed', 'cancelled', 'completed']";
function rules(predicate: string, fallback = 'false', first = false) {
  const relevant = `match /clubs/{club}/seasons/{season}/meets/{id} {
      allow list: if request.query.limit <= 100 && (${predicate});
    }`;
  const sibling = `match /{document=**} { allow read, write: if ${fallback}; }`;
  return `rules_version = '2'; service cloud.firestore {
    match /databases/{database}/documents {
      ${first ? sibling + relevant : relevant + sibling}
    }
  }`;
}
const execution = {
  filters: [
    { kind: 'where' as const, field: 'visibility', op: '==' as const, value: 'public' },
    { kind: 'where' as const, field: 'status', op: '==' as const, value: 'scheduled' },
  ], orders: [], limitCount: 100, limitFromEnd: false,
};

describe('query-proof diagnostics (#583)', () => {
  test('a fallback deny cannot erase the relevant listener proof limitation', () => {
    const env = new LocalEnvironment();
    try {
      const source = rules(membership);
      env.seed({ rules: source, documents: {} });
      const requests: RequestEvent[] = [];
      const errors: { code: string }[] = [];
      let snapshots = 0;
      env.onRequest(event => requests.push(event));
      env.addSnapshotListener({ kind: 'query', collection: path, constraints: { execution } },
        () => snapshots++, {}, null, error => errors.push(error));
      env.flushListeners();
      expect(snapshots).toBe(0);
      expect(errors.map(error => error.code)).toEqual(['permission-denied']);
      const event = requests[0]!;
      expect(event.queryProof?.kind).toBe('unsupported-predicate');
      expect(event.queryProof?.failures[0]?.rule?.expression).toContain('status in');
      const line = event.queryProof?.failures[0]?.rule?.line;
      expect(line).toBeDefined();
      expect(source.split('\n')[line! - 1]).toContain('allow list');
      expect(event.evaluatedRule?.expression).toBe('false'); // actual residual, not fabricated proof trace
      expect(event.reasons.join(' ')).toContain('Pyric');
      expect(event.reasons.join(' ')).not.toContain('No allow rules found');
    } finally { env.dispose(); }
  });
});

for (const op of ['==', 'in'] as const) {
  for (const first of [false, true]) {
    test(`membership with ${op} and fallback first=${first} retains proof evidence independent of stored rows`, () => {
      for (const populated of [false, true]) {
        const env = new LocalEnvironment();
        try {
          env.seed({ rules: rules(membership, 'false', first), documents: populated
            ? { [`${path}/one`]: { visibility: 'public', status: 'scheduled' } } : {} });
          const plan = { ...execution, filters: [execution.filters[0]!, {
            kind: 'where' as const, field: 'status', op,
            value: op === 'in' ? ['scheduled', 'changed', 'cancelled', 'completed'] : 'scheduled',
          }] };
          const result = env.runQuery({ scope: { kind: 'collection', path }, auth: null, execution: plan });
          expect(result.allowed).toBe(false);
          if (result.allowed) throw new Error('expected denial');
          expect(result.error.queryProof?.kind).toBe('unsupported-predicate');
          expect(result.error.rule?.expression).toContain('status in');
          expect(result.error.queryProof?.failures[0]?.residual.predicate).toContain('status in');
          expect(JSON.parse(JSON.stringify(result.error.queryProof)).query.filters[1]).toMatchObject({ kind: 'where', field: 'status', op });
        } finally { env.dispose(); }
      }
    });
  }
}

test('unsupported siblings do not revoke a real grant, and failed residuals remain secondary evidence', () => {
  for (const fallback of ['true', 'request.auth != null']) {
    const env = new LocalEnvironment();
    try {
      env.seed({ rules: rules(membership, fallback), documents: {} });
      const events: RequestEvent[] = [];
      env.onRequest(event => events.push(event));
      const result = env.runQuery({ scope: { kind: 'collection', path }, auth: null, execution });
      expect(result.allowed).toBe(fallback === 'true');
      if (result.allowed) expect(events[0]?.queryProof).toBeUndefined();
      else {
        expect(result.error.queryProof?.kind).toBe('unsupported-predicate');
        expect(events[0]?.evaluatedRule?.expression).toBe('request.auth != null');
      }
    } finally { env.dispose(); }
  }
});

test('constraint failures, unsupported predicates, residual denials and absent rules are distinct', () => {
  const equality = "resource.data.visibility == 'public' && resource.data.status == 'scheduled'";
  const cases = [
    { predicate: equality, plan: execution, allowed: true },
    { predicate: equality, plan: { ...execution, filters: execution.filters.slice(1) }, kind: 'constraints-not-satisfied' },
    { predicate: equality, plan: { ...execution, filters: [execution.filters[0]!, { ...execution.filters[1]!, value: 'forbidden' }] }, kind: 'constraints-not-satisfied' },
    { predicate: equality, plan: { ...execution, filters: [] }, kind: 'constraints-not-satisfied' },
    { predicate: equality, plan: { ...execution, limitCount: 101 }, kind: 'residual-denied' },
    { predicate: `request.auth != null && (${equality})`, plan: execution, kind: 'residual-denied' },
    { predicate: membership, plan: { ...execution, filters: [] }, kind: 'unsupported-predicate' },
    { predicate: membership, plan: { ...execution, filters: [execution.filters[1]!] }, kind: 'unsupported-predicate' },
    { predicate: membership, plan: { ...execution, filters: [execution.filters[0]!, { ...execution.filters[1]!, value: 'forbidden' }] }, kind: 'unsupported-predicate' },
  ];
  for (const scenario of cases) {
    const env = new LocalEnvironment();
    try {
      env.seed({ rules: rules(scenario.predicate), documents: {} });
      const result = env.runQuery({ scope: { kind: 'collection', path }, auth: null, execution: scenario.plan });
      expect(result.allowed).toBe(scenario.allowed === true);
      if (!result.allowed) expect(result.error.queryProof?.kind).toBe(scenario.kind);
    } finally { env.dispose(); }
  }
  const env = new LocalEnvironment();
  try {
    env.seed({ rules: "service cloud.firestore { match /databases/{db}/documents { match /other/{id} { allow list: if false; } } }", documents: {} });
    const result = env.runQuery({ scope: { kind: 'collection', path }, auth: null, execution });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.error.queryProof?.kind).toBe('no-rule');
  } finally { env.dispose(); }
});

test('membership helpers and the published-or-staff shape retain allow-site attribution', () => {
  for (const predicate of ['published(resource.data)', '(published(resource.data) || staff(club))']) {
    const env = new LocalEnvironment();
    try {
      const source = rules(predicate).replace('allow list:', `function published(data) { return data.visibility == 'public' && data.status in ['scheduled']; }
      function staff(club) { return exists(/databases/$(database)/documents/clubs/$(club)/members/me); }
      allow list:`);
      env.seed({ rules: source, documents: {} });
      const result = env.runQuery({ scope: { kind: 'collection', path }, auth: null, execution });
      expect(result.allowed).toBe(false);
      if (result.allowed) throw new Error('expected denial');
      expect(result.error.queryProof?.kind).toBe('unsupported-predicate');
      expect(result.error.rule?.expression).toContain('published');
      expect(source.split('\n')[result.error.rule!.line! - 1]).toContain('allow list');
      expect(result.error.queryProof?.failures[0]?.residual.predicate).toBeDefined();
      const failure = result.error.queryProof!.failures[0]!;
      expect(failure.predicate?.citation).toBeDefined();
      if (predicate === 'published(resource.data)') {
        expect(source.split('\n')[failure.predicate!.line! - 1]).toContain('function published');
        expect(failure.predicate!.line).not.toBe(failure.rule!.line);
      }
    } finally { env.dispose(); }
  }
});


test('public getDocs and onSnapshot carry proof diagnostics in Firebase-compatible errors', async () => {
  const sandbox = initializeSandbox();
  const env = getInternalEnv(sandbox);
  try {
    setRules(sandbox, rules(membership));
    const db = getFirestore(sandbox);
    const q = query(collection(db, path), where('visibility', '==', 'public'),
      where('status', 'in', ['scheduled', 'changed', 'cancelled', 'completed']), limit(100));
    const expected = {
      code: 'permission-denied',
      denialContext: { queryProof: { kind: 'unsupported-predicate' }, rule: { expression: expect.stringContaining('status in') } },
      customData: { denialContext: { queryProof: { kind: 'unsupported-predicate' } } },
    };
    await expect(getDocs(q)).rejects.toMatchObject(expected);
    const captured: SandboxEvent[] = [];
    sandbox.onEvent(event => captured.push(event));
    const errors: unknown[] = [];
    let snapshots = 0;
    const stop = onSnapshot(q, () => snapshots++, error => errors.push(error));
    env.flushListeners();
    expect(snapshots).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject(expected);
    const restored: SandboxEvent[] = JSON.parse(JSON.stringify(captured));
    const request = restored.find(event => event.kind === 'request');
    expect(request?.kind).toBe('request');
    if (!request || request.kind !== 'request') throw new Error('request missing');
    const record = toOperationRecord(request)!;
    expect(record.rules).toEqual({ kind: 'evaluated', verdict: 'deny' });
    expect(record.queryProof?.kind).toBe('unsupported-predicate');
    expect(request.evaluatedRule?.expression).toBe('false');
    expect(restored.find(event => event.kind === 'listener_errored')).toMatchObject({
      error: { code: 'permission-denied', message: expect.stringContaining('Pyric') },
    });
    expect(record.queryProof).not.toBe(request.queryProof);
    expect(Object.isFrozen(record.queryProof?.failures)).toBe(true);
    request.queryProof!.failures[0]!.reason = 'changed capture';
    expect(record.queryProof!.failures[0]!.reason).not.toBe('changed capture');
    delete request.queryProof;
    expect(toOperationRecord(request)?.queryProof).toBeUndefined();
    env.flushListeners();
    expect(errors).toHaveLength(1);
    stop();
  } finally { env.dispose(); }
});

test('an unsupported rule is attributed even without any fallback', () => {
  const env = new LocalEnvironment();
  try {
    env.seed({ rules: rules(membership).replace('match /{document=**} { allow read, write: if false; }', ''), documents: {} });
    const events: RequestEvent[] = [];
    env.onRequest(event => events.push(event));
    env.runQuery({ scope: { kind: 'collection', path }, auth: null, execution });
    expect(events[0]?.queryProof?.failures[0]?.rule?.expression).toContain('status in');
    expect(events[0]?.evaluatedRule).toBeUndefined();
  } finally { env.dispose(); }
});

test('diagnostic serialization never observes arbitrary query operands', () => {
  const env = new LocalEnvironment();
  try {
    let reads = 0;
    const operand = new Proxy({}, { get() { reads++; throw new Error('operand observed'); } });
    env.seed({ rules: rules(membership), documents: {} });
    const result = env.runQuery({ scope: { kind: 'collection', path }, auth: null,
      execution: { ...execution, filters: [{ kind: 'where', field: 'status', op: 'in', value: operand }] },
    });
    expect(result.allowed).toBe(false);
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(reads).toBe(0);
  } finally { env.dispose(); }
});
