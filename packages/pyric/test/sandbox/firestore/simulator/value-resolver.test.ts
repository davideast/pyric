/**
 * Item 0 — Write-boundary value-resolve pass.
 *
 * Verifies the resolver infrastructure that Items 1, 2, 3, 5 will hang
 * converters off of. Item 0 ships an empty registry, so most of these
 * tests target the empty-registry case (identity walk + idempotency)
 * and a single locally-registered toy converter to prove the contract.
 *
 * Tests in this file MUST clean up the registry (`_clearConvertersForTest`)
 * before and after to avoid bleeding state into the rest of the suite —
 * other simulator tests assume the empty default registry.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  resolveValueTree,
  resolveValue,
  registerConverter,
  registerDefaultConverters,
  listConverters,
  KEEP,
  _clearConvertersForTest,
  type ValueConverter,
  type ResolveContext,
} from 'pyric/sandbox/internal';
import { LocalState } from 'pyric/sandbox/internal';
import { LocalEnvironment } from 'pyric/sandbox/internal';

const ALLOW_ALL = `rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; }}}`;

beforeEach(() => {
  _clearConvertersForTest();
});

afterEach(() => {
  // Restore the default (empty in Item 0) registry so other suites that
  // import this module aren't left with leftover toy converters.
  _clearConvertersForTest();
  registerDefaultConverters();
});

// ─── Empty-registry behavior ───────────────────────────────────────────────

describe('resolveValueTree (empty registry)', () => {
  test('returns a structurally-equal copy for primitive-only docs', () => {
    const input = { a: 1, b: 'hi', c: true, d: null };
    const out = resolveValueTree(input, { path: 'p/x', method: 'create', prior: null });
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  test('walks nested maps and arrays, copying — not mutating — input', () => {
    const inner = { x: 1 };
    const arr = [1, 2, { nested: 'v' }];
    const input = { a: inner, b: arr };
    const out = resolveValueTree(input, { path: 'p/x', method: 'create', prior: null });
    expect(out).toEqual(input);
    // Outer copy is fresh.
    expect(out).not.toBe(input);
    // Nested containers are also fresh — the resolver descends and rebuilds.
    expect(out['a']).not.toBe(inner);
    expect(out['b']).not.toBe(arr);
  });

  test('passes through unrecognized class instances unchanged (identity)', () => {
    // Use a class the registry has no converter for. After Item 1, Date
    // IS handled by `dateConverter`, so Date can no longer test the
    // pass-through path. A bespoke class with no registered converter
    // exercises the same contract.
    class UnknownWrapper {
      constructor(public readonly tag: string) {}
    }
    const wrapper = new UnknownWrapper('keep-me');
    const out = resolveValueTree({ obj: wrapper }, { path: 'p/x', method: 'create', prior: null });
    // No converter claimed it — silently rebuilding as a plain map
    // would erase the prototype future converters need to detect.
    expect(out['obj']).toBe(wrapper);
  });

  test('is idempotent — resolving twice equals resolving once', () => {
    const input = { a: 1, nested: { b: [1, 2] } };
    const once = resolveValueTree(input, { path: 'p/x', method: 'create', prior: null });
    const twice = resolveValueTree(once, { path: 'p/x', method: 'create', prior: null });
    expect(twice).toEqual(once);
  });
});

// ─── Converter contract ───────────────────────────────────────────────────

describe('ValueConverter contract', () => {
  test('a converter that returns KEEP declines; the resolver descends', () => {
    const seen: unknown[] = [];
    const declining: ValueConverter = {
      name: 'declining',
      convert(v) {
        seen.push(v);
        return KEEP;
      },
    };
    registerConverter(declining);
    const input = { a: { b: 1 } };
    const out = resolveValueTree(input, { path: 'p/x', method: 'create', prior: null });
    // Declining converter offered every value (the outer map's value, then
    // the nested map's value, then the leaf primitive).
    expect(seen).toContainEqual({ b: 1 });
    expect(seen).toContainEqual(1);
    // Nothing claimed; identity walk produces a copy equal to input.
    expect(out).toEqual(input);
  });

  test('a converter substitution is taken as-is — resolver does NOT descend into it', () => {
    const claimMap: ValueConverter = {
      name: 'claim-map',
      convert(v) {
        // Claim every plain object with a sentinel marker.
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          return { __converted: true, original: v };
        }
        return KEEP;
      },
    };
    registerConverter(claimMap);
    const out = resolveValueTree(
      { wrapped: { a: 1 } },
      { path: 'p/x', method: 'create', prior: null },
    );
    // The converter's substitution is preserved verbatim — the resolver
    // does not re-descend into `original` and re-claim it.
    expect(out).toEqual({
      wrapped: { __converted: true, original: { a: 1 } },
    });
  });

  test('first-wins ordering for multiple converters', () => {
    const first: ValueConverter = {
      name: 'first',
      convert(v) {
        return v === 'target' ? 'first-claimed' : KEEP;
      },
    };
    const second: ValueConverter = {
      name: 'second',
      convert(v) {
        return v === 'target' ? 'second-claimed' : KEEP;
      },
    };
    registerConverter(first);
    registerConverter(second);
    const out = resolveValue('target', { path: 'p/x', method: 'create', prior: null, fieldPath: 'f' });
    expect(out).toBe('first-claimed');
  });

  test('registerConverter is idempotent on name', () => {
    const c: ValueConverter = { name: 'dup', convert: () => KEEP };
    registerConverter(c);
    registerConverter(c);
    registerConverter({ name: 'dup', convert: () => 'should-not-replace' });
    expect(listConverters()).toEqual(['dup']);
  });

  test('converter receives ResolveContext with method, path, prior, fieldPath', () => {
    const captured: ResolveContext[] = [];
    registerConverter({
      name: 'capture',
      convert(_v, ctx) {
        captured.push(ctx);
        return KEEP;
      },
    });
    resolveValueTree(
      { top: { nested: 1 }, list: [10] },
      { path: 'users/u1', method: 'update', prior: { existing: true } },
    );
    // The top-level field hits with fieldPath='top'.
    expect(captured.some((c) => c.fieldPath === 'top' && c.method === 'update')).toBe(true);
    // The nested field is dotted.
    expect(captured.some((c) => c.fieldPath === 'top.nested')).toBe(true);
    // The array index is bracketed.
    expect(captured.some((c) => c.fieldPath === 'list[0]')).toBe(true);
    // Prior is forwarded verbatim — Item 2's increment converter needs this.
    expect(captured[0]!.prior).toEqual({ existing: true });
    expect(captured[0]!.path).toBe('users/u1');
  });
});

// ─── LocalState integration (write boundary) ──────────────────────────────

describe('LocalState — resolver wiring at write boundary', () => {
  test('seed pass calls resolver with method=seed and prior=null', () => {
    const ctxs: ResolveContext[] = [];
    registerConverter({
      name: 'spy',
      convert(_v, ctx) {
        ctxs.push(ctx);
        return KEEP;
      },
    });
    new LocalState({ 'users/u1': { name: 'A' } });
    const seedCtx = ctxs.find((c) => c.fieldPath === 'name');
    expect(seedCtx).toBeDefined();
    expect(seedCtx!.method).toBe('seed');
    expect(seedCtx!.prior).toBeNull();
    expect(seedCtx!.path).toBe('users/u1');
  });

  test('create routes through resolver with method=create and prior=null', () => {
    const ctxs: ResolveContext[] = [];
    registerConverter({
      name: 'spy',
      convert(_v, ctx) {
        ctxs.push(ctx);
        return KEEP;
      },
    });
    const s = new LocalState();
    s.create('posts/p1', { title: 'hi' });
    const ctx = ctxs.find((c) => c.fieldPath === 'title');
    expect(ctx).toBeDefined();
    expect(ctx!.method).toBe('create');
    expect(ctx!.prior).toBeNull();
  });

  test('update routes through resolver with prior = existing doc', () => {
    const ctxs: ResolveContext[] = [];
    registerConverter({
      name: 'spy',
      convert(_v, ctx) {
        ctxs.push(ctx);
        return KEEP;
      },
    });
    const s = new LocalState({ 'users/u1': { name: 'A', age: 30 } });
    // Drain seed-pass spies; only assert about the update call.
    const startLen = ctxs.length;
    s.update('users/u1', { age: 31 });
    const updateCtxs = ctxs.slice(startLen);
    const ctx = updateCtxs.find((c) => c.fieldPath === 'age');
    expect(ctx).toBeDefined();
    expect(ctx!.method).toBe('update');
    expect(ctx!.prior).toEqual({ name: 'A', age: 30 });
  });

  test('set routes through resolver with prior = existing-or-null', () => {
    const ctxs: ResolveContext[] = [];
    registerConverter({
      name: 'spy',
      convert(_v, ctx) {
        ctxs.push(ctx);
        return KEEP;
      },
    });
    const s = new LocalState({ 'users/u1': { x: 1 } });
    const startLen = ctxs.length;
    s.set('users/u1', { y: 2 });
    s.set('users/u2', { z: 3 }); // Doc didn't exist before this set.
    const setCtxs = ctxs.slice(startLen);
    const overwrite = setCtxs.find((c) => c.path === 'users/u1' && c.method === 'set');
    expect(overwrite!.prior).toEqual({ x: 1 });
    const fresh = setCtxs.find((c) => c.path === 'users/u2' && c.method === 'set');
    expect(fresh!.prior).toBeNull();
  });

  test('applyBatch resolves each op with the prior captured before the batch', () => {
    const ctxs: ResolveContext[] = [];
    registerConverter({
      name: 'spy',
      convert(_v, ctx) {
        ctxs.push(ctx);
        return KEEP;
      },
    });
    const s = new LocalState({ 'a/1': { v: 1 }, 'b/1': { v: 2 } });
    const startLen = ctxs.length;
    s.applyBatch([
      { method: 'update', path: 'a/1', data: { v: 10 } },
      { method: 'set', path: 'b/1', data: { v: 20 } },
      { method: 'create', path: 'c/1', data: { v: 30 } },
    ]);
    const batchCtxs = ctxs.slice(startLen);
    const updCtx = batchCtxs.find((c) => c.path === 'a/1' && c.method === 'update');
    expect(updCtx!.prior).toEqual({ v: 1 });
    const setCtx = batchCtxs.find((c) => c.path === 'b/1' && c.method === 'set');
    expect(setCtx!.prior).toEqual({ v: 2 });
    const createCtx = batchCtxs.find((c) => c.path === 'c/1' && c.method === 'create');
    expect(createCtx!.prior).toBeNull();
  });

  test('a substituting converter actually changes what gets stored', () => {
    registerConverter({
      name: 'string-uppercaser',
      convert(v) {
        return typeof v === 'string' ? v.toUpperCase() : KEEP;
      },
    });
    const s = new LocalState();
    s.create('users/u1', { name: 'alice' });
    expect(s.get('users/u1')).toEqual({ name: 'ALICE' });
  });
});

// ─── LocalEnvironment integration (rules see the resolved value) ─────────

describe('LocalEnvironment — pre-rules resolution', () => {
  test('rules evaluate against resolved data, not the raw write payload', () => {
    // Toy converter: replace any string field with its length so a rule
    // that branches on `request.resource.data.title is int` becomes true
    // only because the resolver ran BEFORE rules.
    registerConverter({
      name: 'string-to-length',
      convert(v) {
        return typeof v === 'string' ? v.length : KEEP;
      },
    });

    const env = new LocalEnvironment();
    env.seed({
      rules:
        "rules_version = '2'; service cloud.firestore { " +
        '  match /databases/{database}/documents { ' +
        // Allow writes only when `title` was resolved to an int.
        '    match /posts/{p} { allow create: if request.resource.data.title is int; }' +
        '  }' +
        '}',
      documents: {},
    });

    const result = env.execute({
      method: 'create',
      path: 'posts/p1',
      auth: { uid: 'u1' },
      data: { title: 'hello' }, // Length 5 after resolution.
    });
    expect(result.allowed).toBe(true);
    expect(env.getDocument('posts/p1')).toEqual({ title: 5 });
  });

  test('idempotency: converter applied via env.execute and again in LocalState yields same value', () => {
    registerConverter({
      name: 'string-uppercaser',
      convert(v) {
        return typeof v === 'string' ? v.toUpperCase() : KEEP;
      },
    });
    const env = new LocalEnvironment();
    env.seed({ rules: ALLOW_ALL });
    env.execute({
      method: 'create',
      path: 'users/u1',
      auth: { uid: 'u1' },
      data: { name: 'alice' },
    });
    // Despite resolution running twice (env.execute + LocalState.create),
    // the stored value is the converter's output once — uppercase('ALICE')
    // returns 'ALICE' (a no-op on its own output).
    expect(env.getDocument('users/u1')).toEqual({ name: 'ALICE' });
  });
});

// ─── Default registry ────────────────────────────────────────────────────

describe('registerDefaultConverters', () => {
  test('ships every Item N converter as it lands — Items 1 + 2 + 3 + 5 + 6 + FS-B4', () => {
    _clearConvertersForTest();
    registerDefaultConverters();
    // First wave (Item 1): Date and serverTimestamp sentinel.
    // FS-B4: a user-written compat/firebase Timestamp → rules-internal
    // Timestamp (unifies storage so `is timestamp` holds + comparability).
    // Second wave (Item 2): increment, arrayUnion, arrayRemove, deleteField.
    // Third wave (Item 3): admin SDK DocumentReference → Reference wrapper.
    // Fourth wave (Item 5): admin SDK VectorValue → Vector wrapper.
    // Fifth wave (Item 6): firebase/firestore Bytes / GeoPoint → rules
    // wrappers — closes COMPAT rows #109 + #110.
    expect(listConverters()).toEqual([
      'date-to-timestamp',
      'server-timestamp-sentinel',
      'user-timestamp-to-rules-timestamp',
      'increment-sentinel',
      'array-union-sentinel',
      'array-remove-sentinel',
      'delete-field-sentinel',
      'document-reference',
      'vector-value',
      'fb-bytes-to-rules-bytes',
      'fb-geopoint-to-rules-latlng',
    ]);
  });
});
