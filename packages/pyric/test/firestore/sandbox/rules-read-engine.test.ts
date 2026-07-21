/**
 * Direct RulesReadEngine unit tests (ADR-0009, PR B3).
 *
 * Exercises the rules-gated read paths directly against real collaborators
 * (LocalState, RulesState, the real simulator, TriggerScope, EventBus) and
 * a minimal read-only RulesReadHost. Engine-level behavior — listener
 * delivery, rules-flip re-evaluation, attribution ordering — stays covered
 * by the characterization pins and simulator suites; these tests pin the
 * module's own contract: allow/deny/bypass results, RULES-B11 unprovable
 * denial, and the RequestEvent / denial emissions.
 */
import { describe, test, expect } from 'bun:test';
import { RulesReadEngine, type RulesReadHost } from '../../../src/firestore/sandbox/rules-read-engine.js';
import { RulesState } from '../../../src/firestore/sandbox/rules-state.js';
import { LocalState } from '../../../src/firestore/sandbox/local-state.js';
import { FirestoreEventBus } from '../../../src/firestore/sandbox/event-bus.js';
import { TriggerScope } from '../../../src/firestore/sandbox/trigger-scope.js';
import { SimulateFirestoreRulesHandler } from 'pyric/rules/internal';
import type { RequestEvent } from '../../../src/sandbox/types/events.js';
import { EventLog } from '../../../src/firestore/sandbox/event-log.js';
import type { QueryConstraintApplier } from '../../../src/firestore/sandbox/snapshot-listeners.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;

const CLOSED_RULES = OPEN_RULES.replace('if true', 'if false');

// A `list` rule with a doc-data conjunct: provable only when the query
// pins `visibility == 'public'` via where(); unprovable otherwise
// (RULES-B11 — rules are not filters).
const DATA_GATED_LIST_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{id} {
      allow list: if resource.data.visibility == 'public';
      allow get: if true;
    }
  }
}`;

function makeEngine(rulesSource: string, docs: Record<string, Record<string, unknown>> = {}) {
  const state = new LocalState(docs);
  const rules = new RulesState(rulesSource);
  const events = new FirestoreEventBus();
  const triggerScope = new TriggerScope();
  const eventLog = new EventLog();
  const host: RulesReadHost = {
    get state() { return state; },
  };
  const engine = new RulesReadEngine(
    events,
    triggerScope,
    rules,
    new SimulateFirestoreRulesHandler(),
    host,
    eventLog,
  );
  return { engine, state, rules, events, triggerScope, eventLog };
}

describe('RulesReadEngine.execute', () => {
  test('owns user read evaluation and history recording', () => {
    const { engine, eventLog } = makeEngine(OPEN_RULES, {
      'games/g1': { title: 'chess' },
    });

    const result = engine.execute({ method: 'get', path: 'games/g1', auth: null });

    expect(result.allowed).toBe(true);
    expect(result.data).toEqual({ title: 'chess' });
    expect(eventLog.size()).toBe(1);
  });

  test('emits a structured denial for a user read', () => {
    const { engine, events } = makeEngine(CLOSED_RULES, {
      'games/g1': { title: 'chess' },
    });
    const denials: unknown[] = [];
    events.denial.subscribe((error) => denials.push(error));

    const result = engine.execute({ method: 'get', path: 'games/g1', auth: null });

    expect(result.allowed).toBe(false);
    expect(result.error?.code).toBe('permission-denied');
    expect(denials).toHaveLength(1);
  });
});

describe('RulesReadEngine.silentReadDoc', () => {
  test('allows under open rules and returns the doc data', () => {
    const { engine } = makeEngine(OPEN_RULES, { 'games/g1': { title: 'chess' } });
    const r = engine.silentReadDoc('games/g1', { uid: 'u1' });
    expect(r).toEqual({ allowed: true, data: { title: 'chess' } });
  });

  test('denies under closed rules with a permission-denied error and emits a listener-origin deny event', () => {
    const { engine, events } = makeEngine(CLOSED_RULES, { 'games/g1': { title: 'chess' } });
    const seen: RequestEvent[] = [];
    events.request.subscribe((e) => seen.push(e));
    const r = engine.silentReadDoc('games/g1', { uid: 'u1' });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error.code).toBe('permission-denied');
      expect(r.error.request).toEqual({ method: 'get', path: 'games/g1', auth: { uid: 'u1' } });
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.result).toBe('deny');
    expect(seen[0]!.origin).toBe('listener');
    expect(seen[0]!.method).toBe('get');
  });

  test('bypassRules skips evaluation (allows under closed rules) and marks the event admin', () => {
    const { engine, events } = makeEngine(CLOSED_RULES, { 'games/g1': { title: 'chess' } });
    const seen: RequestEvent[] = [];
    events.request.subscribe((e) => seen.push(e));
    const r = engine.silentReadDoc('games/g1', null, true);
    expect(r).toEqual({ allowed: true, data: { title: 'chess' } });
    expect(seen[0]!.result).toBe('allow');
    expect(seen[0]!.detail).toEqual({ admin: true });
  });

  test('stamps triggeredBy from the ambient TriggerScope', () => {
    const { engine, events, triggerScope } = makeEngine(OPEN_RULES, { 'games/g1': { n: 1 } });
    const seen: RequestEvent[] = [];
    events.request.subscribe((e) => seen.push(e));
    triggerScope.run({ method: 'update', path: 'games/g1' }, () => {
      engine.silentReadDoc('games/g1', { uid: 'u1' });
    });
    expect(seen[0]!.triggeredBy).toEqual({ method: 'update', path: 'games/g1' });
  });
});

describe('RulesReadEngine.silentReadCollection', () => {
  test('allows under open rules and returns real docs (phantom parents dropped)', () => {
    const { engine } = makeEngine(OPEN_RULES, {
      'games/g1': { title: 'chess' },
      'games/g2/moves/m1': { n: 1 }, // makes games/g2 a phantom parent
    });
    const r = engine.silentReadCollection('games', { uid: 'u1' });
    expect(r.allowed).toBe(true);
    if (r.allowed) {
      expect(r.docs.map((d) => d.path)).toEqual(['games/g1']);
    }
  });

  test('RULES-B11: denies the whole query as unprovable when a doc-data conjunct is not pinned', () => {
    const { engine, events } = makeEngine(DATA_GATED_LIST_RULES, {
      'posts/p1': { visibility: 'public' },
    });
    const seen: RequestEvent[] = [];
    events.request.subscribe((e) => seen.push(e));
    const r = engine.silentReadCollection('posts', { uid: 'u1' });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error.code).toBe('permission-denied');
      expect(r.error.message).toContain('rules are not filters');
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.result).toBe('deny');
    expect(seen[0]!.origin).toBe('listener');
  });

  test('denies under closed rules with one deny event for the whole list', () => {
    const { engine, events } = makeEngine(CLOSED_RULES, { 'games/g1': { n: 1 } });
    const seen: RequestEvent[] = [];
    events.request.subscribe((e) => seen.push(e));
    const r = engine.silentReadCollection('games', null);
    expect(r.allowed).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('list');
    expect(seen[0]!.path).toBe('games');
  });

  test('bypassRules returns every doc under closed rules', () => {
    const { engine } = makeEngine(CLOSED_RULES, { 'games/g1': { n: 1 }, 'games/g2': { n: 2 } });
    const r = engine.silentReadCollection('games', null, undefined, true);
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.docs).toHaveLength(2);
  });

  test('captures a listener execution accessor once for both proof and execution', () => {
    const { engine } = makeEngine(DATA_GATED_LIST_RULES, {
      'posts/public': { visibility: 'public' },
      'posts/private': { visibility: 'private' },
    });
    let reads = 0;
    const constraints = {
      get execution() {
        reads += 1;
        return reads === 1
          ? {
              filters: [{ kind: 'where' as const, field: 'visibility', op: '==' as const, value: 'public' }],
              orders: [],
              limitFromEnd: false,
            }
          : { filters: [], orders: [], limitFromEnd: false };
      },
    };

    const result = engine.silentReadCollection('posts', null, constraints);

    expect(reads).toBe(1);
    expect(result).toEqual({
      allowed: true,
      docs: [{ path: 'posts/public', data: { visibility: 'public' } }],
    });
  });

  test('captures nested listener filter getters before proof and execution', () => {
    const { engine } = makeEngine(DATA_GATED_LIST_RULES, {
      'posts/public': { visibility: 'public' },
      'posts/private': { visibility: 'private' },
    });
    let reads = 0;
    const filter = {
      kind: 'where' as const,
      field: 'visibility',
      op: '==' as const,
      get value() {
        reads += 1;
        return reads === 1 ? 'public' : 'private';
      },
    };

    const result = engine.silentReadCollection('posts', null, {
      execution: { filters: [filter], orders: [], limitFromEnd: false },
    });

    expect(reads).toBe(1);
    expect(result).toEqual({
      allowed: true,
      docs: [{ path: 'posts/public', data: { visibility: 'public' } }],
    });
  });

  test('fails closed for the deprecated callable listener constraint', () => {
    const { engine } = makeEngine(OPEN_RULES, {
      'posts/public': { visibility: 'public' },
      'posts/private': { visibility: 'private' },
    });
    const legacy: QueryConstraintApplier = (rows) => rows;

    const result = engine.silentReadCollection('posts', null, legacy);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.error.code).toBe('invalid-argument');
      expect(result.error.message).toContain('Callable query constraints');
    }
  });
});

describe('RulesReadEngine.runQuery', () => {
  const docs = { 'games/g1': { n: 1 }, 'games/g2': { n: 2 } };
  const execution = {
    filters: [],
    orders: [],
    limitFromEnd: false,
  };

  test('allows under open rules, returns candidates untouched, emits one user-origin allow', () => {
    const { engine, events } = makeEngine(OPEN_RULES, docs);
    const seen: RequestEvent[] = [];
    events.request.subscribe((e) => seen.push(e));
    const r = engine.runQuery({
      scope: { kind: 'collection', path: 'games' },
      listPath: 'games',
      auth: { uid: 'u1' },
      execution,
    });
    expect(r).toEqual({
      allowed: true,
      docs: [
        { path: 'games/g1', data: { n: 1 } },
        { path: 'games/g2', data: { n: 2 } },
      ],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.result).toBe('allow');
    expect(seen[0]!.origin).toBe('user');
  });

  test('denies under closed rules and emits on the denial channel', () => {
    const { engine, events } = makeEngine(CLOSED_RULES, docs);
    const denials: unknown[] = [];
    events.denial.subscribe((e) => denials.push(e));
    const r = engine.runQuery({
      scope: { kind: 'collection', path: 'games' },
      listPath: 'games',
      auth: { uid: 'u1' },
      execution,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error.code).toBe('permission-denied');
    expect(denials).toHaveLength(1);
  });

  test('bypassRules skips the proof gate and returns all candidates under closed rules', () => {
    const { engine, events } = makeEngine(CLOSED_RULES, docs);
    const seen: RequestEvent[] = [];
    events.request.subscribe((e) => seen.push(e));
    const r = engine.runQuery({
      scope: { kind: 'collection', path: 'games' },
      listPath: 'games',
      auth: null,
      execution,
      bypassRules: true,
    });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.docs).toHaveLength(2);
    expect(seen[0]!.detail).toEqual({ admin: true });
  });

  test('gathers and executes collection-group constraints behind the engine seam', () => {
    const { engine } = makeEngine(OPEN_RULES, {
      'parents/a/items/one': { score: 1 },
      'parents/b/items/two': { score: 2 },
      'parents/b/other/nope': { score: 3 },
    });

    const result = engine.runQuery({
      scope: { kind: 'collection-group', collectionId: 'items' },
      listPath: 'items',
      auth: null,
      execution: {
        filters: [{ kind: 'where', field: 'score', op: '>=', value: 2 }],
        orders: [],
        limitFromEnd: false,
      },
    });

    expect(result).toEqual({
      allowed: true,
      docs: [{ path: 'parents/b/items/two', data: { score: 2 } }],
    });
  });

  test('captures a request execution accessor once for both proof and execution', () => {
    const { engine } = makeEngine(DATA_GATED_LIST_RULES, {
      'posts/public': { visibility: 'public' },
      'posts/private': { visibility: 'private' },
    });
    let reads = 0;
    const request = {
      scope: { kind: 'collection' as const, path: 'posts' },
      listPath: 'posts',
      auth: null,
      get execution() {
        reads += 1;
        return reads === 1
          ? {
              filters: [{ kind: 'where' as const, field: 'visibility', op: '==' as const, value: 'public' }],
              orders: [],
              limitFromEnd: false,
            }
          : { filters: [], orders: [], limitFromEnd: false };
      },
    };

    const result = engine.runQuery(request);

    expect(reads).toBe(1);
    expect(result).toEqual({
      allowed: true,
      docs: [{ path: 'posts/public', data: { visibility: 'public' } }],
    });
  });

  test('captures nested request filter getters before proof and execution', () => {
    const { engine } = makeEngine(DATA_GATED_LIST_RULES, {
      'posts/public': { visibility: 'public' },
      'posts/private': { visibility: 'private' },
    });
    let reads = 0;
    const filter = {
      kind: 'where' as const,
      field: 'visibility',
      op: '==' as const,
      get value() {
        reads += 1;
        return reads === 1 ? 'public' : 'private';
      },
    };

    const result = engine.runQuery({
      scope: { kind: 'collection', path: 'posts' },
      listPath: 'posts',
      auth: null,
      execution: { filters: [filter], orders: [], limitFromEnd: false },
    });

    expect(reads).toBe(1);
    expect(result).toEqual({
      allowed: true,
      docs: [{ path: 'posts/public', data: { visibility: 'public' } }],
    });
  });
});
