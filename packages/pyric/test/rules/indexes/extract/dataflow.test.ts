/**
 * Unit tests for scanFunctionBody. Each test wraps a JS snippet in a
 * function declaration, locates that function's body, and asserts the
 * QueryBaseDecl shape.
 */
import { describe, test, expect } from 'bun:test';
import ts from 'typescript';
import { scanFunctionBody, type CallResolver } from '../../../../src/rules/indexes/extract/dataflow.js';
import { findFunctionByName, parseSource } from '../../../../src/rules/indexes/extract/ast.js';

function scan(snippet: string, fnName = 'fn', varName = 'q') {
  const sf = parseSource('test.js', snippet);
  const body = findFunctionByName(sf, fnName);
  if (!body) throw new Error(`function ${fnName} not found`);
  return scanFunctionBody(body, varName);
}

/**
 * Build a `CallResolver` that looks up function decls in the same
 * source file by name. Pulls the chain parameter name out of the called
 * function's parameter list using the supplied argIndex.
 */
function makeResolver(sf: ts.SourceFile): CallResolver {
  return (functionName, chainArgIndex) => {
    const body = findFunctionByName(sf, functionName);
    if (!body) return null;
    // Walk back up to the enclosing function-like to read its params.
    let cur: ts.Node | undefined = body.parent;
    while (cur && !ts.isFunctionDeclaration(cur) && !ts.isFunctionExpression(cur) && !ts.isArrowFunction(cur)) {
      cur = cur.parent;
    }
    if (!cur) return null;
    const params = (cur as ts.FunctionLikeDeclaration).parameters;
    const p = params[chainArgIndex];
    if (!p || !ts.isIdentifier(p.name)) return null;
    return { body, chainParamName: p.name.text };
  };
}

function scanWithResolver(snippet: string, fnName = 'fn', varName = 'q') {
  const sf = parseSource('test.js', snippet);
  const body = findFunctionByName(sf, fnName);
  if (!body) throw new Error(`function ${fnName} not found`);
  return scanFunctionBody(body, varName, makeResolver(sf));
}

describe('scanFunctionBody — basic', () => {
  test('let q = query(collection(...)) → INIT recorded, no fragments', () => {
    const decl = scan(`
      function fn() {
        let q = query(collection(db, "restaurants"));
        return q;
      }
    `);
    expect(decl.collectionPath).toBe('restaurants');
    expect(decl.isCollectionGroup).toBe(false);
    expect(decl.fragments).toHaveLength(0);
  });

  test('init via collectionGroup → isCollectionGroup true', () => {
    const decl = scan(`
      function fn() {
        const q = query(collectionGroup(db, "comments"));
      }
    `);
    expect(decl.isCollectionGroup).toBe(true);
    expect(decl.collectionPath).toBe('comments');
  });

  test('chained wraps under no branches → unconditional fragments', () => {
    const decl = scan(`
      function fn() {
        let q = query(collection(db, "r"));
        q = query(q, where("city", "==", "SF"));
        q = query(q, orderBy("rating", "desc"));
      }
    `);
    expect(decl.fragments).toHaveLength(2);
    expect(decl.fragments.every(f => f.branchId === null)).toBe(true);
    expect(decl.fragments[0].kind).toBe('where');
    expect(decl.fragments[1].kind).toBe('orderBy');
  });

  test('fragments inside init are also captured', () => {
    const decl = scan(`
      function fn() {
        const q = query(collection(db, "r"), where("a", "==", 1), orderBy("b"));
      }
    `);
    expect(decl.fragments).toHaveLength(2);
    expect(decl.fragments.map(f => f.kind)).toEqual(['where', 'orderBy']);
  });
});

describe('scanFunctionBody — branches', () => {
  test('skippable optional if (no else) marks fragments skippable', () => {
    const decl = scan(`
      function fn() {
        let q = query(collection(db, "r"));
        if (city) q = query(q, where("city", "==", city));
      }
    `);
    expect(decl.fragments).toHaveLength(1);
    const f = decl.fragments[0];
    expect(f.branchId).not.toBeNull();
    expect(f.skippable).toBe(true);
    expect(f.clauseId).toBe(0);
  });

  test('if/else marks both clauses as not-skippable', () => {
    const decl = scan(`
      function fn() {
        let q = query(collection(db, "r"));
        if (sort === "Rating") q = query(q, orderBy("avgRating", "desc"));
        else q = query(q, orderBy("numRatings", "desc"));
      }
    `);
    expect(decl.fragments).toHaveLength(2);
    expect(decl.fragments.every(f => !f.skippable)).toBe(true);
    expect(decl.fragments[0].clauseId).toBe(0);
    expect(decl.fragments[1].clauseId).toBe(1);
    // Same branchId — they're alternatives.
    expect(decl.fragments[0].branchId).toBe(decl.fragments[1].branchId);
  });

  test('if/else-if/else has three clauseIds', () => {
    const decl = scan(`
      function fn() {
        let q = query(collection(db, "r"));
        if (s === "A") q = query(q, orderBy("a"));
        else if (s === "B") q = query(q, orderBy("b"));
        else q = query(q, orderBy("c"));
      }
    `);
    expect(decl.fragments).toHaveLength(3);
    expect(decl.fragments.map(f => f.clauseId)).toEqual([0, 1, 2]);
    expect(decl.fragments.every(f => !f.skippable)).toBe(true);
  });

  test('if/else-if without else — chain is skippable', () => {
    const decl = scan(`
      function fn() {
        let q = query(collection(db, "r"));
        if (s === "A") q = query(q, orderBy("a"));
        else if (s === "B") q = query(q, orderBy("b"));
      }
    `);
    expect(decl.fragments).toHaveLength(2);
    expect(decl.fragments.every(f => f.skippable)).toBe(true);
  });

  test('multiple independent if-chains get distinct branchIds', () => {
    const decl = scan(`
      function fn() {
        let q = query(collection(db, "r"));
        if (a) q = query(q, where("a", "==", 1));
        if (b) q = query(q, where("b", "==", 2));
      }
    `);
    expect(decl.fragments).toHaveLength(2);
    expect(decl.fragments[0].branchId).not.toBe(decl.fragments[1].branchId);
  });
});

describe('scanFunctionBody — branchId state isolation', () => {
  test('per-invocation branchId starts at 1 each call', () => {
    const a = scan(`
      function fn() {
        let q = query(collection(db, "r"));
        if (x) q = query(q, where("x", "==", 1));
      }
    `);
    const b = scan(`
      function fn() {
        let q = query(collection(db, "r"));
        if (y) q = query(q, where("y", "==", 1));
      }
    `);
    // Both invocations should see branchId === 1 — proves no module-level
    // counter leakage between calls.
    expect(a.fragments[0].branchId).toBe(1);
    expect(b.fragments[0].branchId).toBe(1);
  });
});

describe('scanFunctionBody — assignment shape variants', () => {
  test('const declaration also recorded as INIT', () => {
    const decl = scan(`
      function fn() {
        const q = query(collection(db, "r"));
      }
    `);
    expect(decl.collectionPath).toBe('r');
  });

  test('var declaration also recorded as INIT', () => {
    const decl = scan(`
      function fn() {
        var q = query(collection(db, "r"));
      }
    `);
    expect(decl.collectionPath).toBe('r');
  });

  test('only the first INIT wins on re-init', () => {
    const decl = scan(`
      function fn() {
        let q = query(collection(db, "first"));
        q = query(collection(db, "second"));
      }
    `);
    expect(decl.collectionPath).toBe('first');
  });

  test('assignment to a different identifier is ignored', () => {
    const decl = scan(`
      function fn() {
        let other = query(collection(db, "x"));
        let q = query(collection(db, "r"));
        other = query(other, where("ignored", "==", 1));
      }
    `);
    expect(decl.collectionPath).toBe('r');
    expect(decl.fragments).toHaveLength(0);
  });
});

describe('scanFunctionBody — inter-procedural follow (Layer 2.5)', () => {
  test('no resolver: caller with wrapper call surfaces nothing extra', () => {
    // Without a resolver, the wrapper call is silently ignored — same
    // behavior as Layer 1. This guards the default path.
    const decl = scan(`
      function applyFilters(q, c) {
        if (c) q = query(q, where("category", "==", c));
        return q;
      }
      function fn() {
        let q = query(collection(db, "r"));
        q = applyFilters(q, "burgers");
      }
    `);
    expect(decl.collectionPath).toBe('r');
    expect(decl.fragments).toHaveLength(0);
    expect(decl.inlinedFunctions).toBeUndefined();
    expect(decl.interProcWarnings).toBeUndefined();
  });

  test('resolver inlines wrapper fragments at the call site', () => {
    const decl = scanWithResolver(`
      function applyFilters(q, c) {
        q = query(q, where("category", "==", c));
        q = query(q, orderBy("avgRating", "desc"));
        return q;
      }
      function fn() {
        let q = query(collection(db, "restaurants"));
        q = applyFilters(q, "burgers");
      }
    `);
    expect(decl.collectionPath).toBe('restaurants');
    expect(decl.fragments).toHaveLength(2);
    expect(decl.fragments[0].kind).toBe('where');
    expect(decl.fragments[0].filter?.field).toBe('category');
    expect(decl.fragments[1].kind).toBe('orderBy');
    expect(decl.fragments[1].order?.field).toBe('avgRating');
    expect(decl.inlinedFunctions).toEqual(['applyFilters']);
  });

  test('wrapper branches get distinct branchIds (shared counter)', () => {
    const decl = scanWithResolver(`
      function applyFilters(q, opts) {
        if (opts.cat) q = query(q, where("category", "==", opts.cat));
        if (opts.city) q = query(q, where("city", "==", opts.city));
      }
      function fn() {
        let q = query(collection(db, "r"));
        if (sort) q = query(q, orderBy("rating", sort));
        q = applyFilters(q, opts);
      }
    `);
    // 1 caller-branch + 2 wrapper-branches; all branchIds distinct.
    const ids = new Set(decl.fragments.map(f => f.branchId).filter(b => b !== null));
    expect(ids.size).toBeGreaterThanOrEqual(3);
  });

  test('chain var not in args → no inline, no warning', () => {
    const decl = scanWithResolver(`
      function helper(opts) {
        return opts.x;
      }
      function fn() {
        let q = query(collection(db, "r"));
        q = helper({ x: 1 });
      }
    `);
    expect(decl.fragments).toHaveLength(0);
    expect(decl.inlinedFunctions).toBeUndefined();
    expect(decl.interProcWarnings).toBeUndefined();
  });

  test('resolver returns null → no inline, no warning', () => {
    // Function exists in source but the resolver intentionally rejects
    // it (e.g. cross-file or unknown).
    const sf = parseSource('test.js', `
      function applyFilters(q, c) { q = query(q, where("category", "==", c)); }
      function fn() {
        let q = query(collection(db, "r"));
        q = applyFilters(q, "x");
      }
    `);
    const body = findFunctionByName(sf, 'fn')!;
    const decl = scanFunctionBody(body, 'q', () => null);
    expect(decl.fragments).toHaveLength(0);
    expect(decl.inlinedFunctions).toBeUndefined();
  });

  test('nested call (inside if-branch) emits warning, no inline', () => {
    const decl = scanWithResolver(`
      function applyFilters(q, c) {
        q = query(q, where("category", "==", c));
      }
      function fn() {
        let q = query(collection(db, "r"));
        if (cond) q = applyFilters(q, "x");
      }
    `);
    expect(decl.fragments).toHaveLength(0);
    expect(decl.inlinedFunctions).toBeUndefined();
    expect(decl.interProcWarnings).toEqual([
      { code: 'inter-proc-nested', functionName: 'applyFilters', message: expect.any(String) },
    ]);
  });

  test('two callers of the same wrapper produce equivalent results', () => {
    // Each caller is scanned independently; the wrapper inlines the same
    // way each time. (Composite-dedupe at the index-spec layer collapses
    // duplicates — out of scope here.)
    const sf = parseSource('test.js', `
      function applyFilters(q, c) {
        q = query(q, where("category", "==", c));
      }
      function getA() {
        let q = query(collection(db, "restaurants"));
        q = applyFilters(q, "burgers");
      }
      function getB() {
        let q = query(collection(db, "restaurants"));
        q = applyFilters(q, "pizza");
      }
    `);
    const resolver = makeResolver(sf);
    const a = scanFunctionBody(findFunctionByName(sf, 'getA')!, 'q', resolver);
    const b = scanFunctionBody(findFunctionByName(sf, 'getB')!, 'q', resolver);
    expect(a.fragments.map(f => f.kind)).toEqual(['where']);
    expect(b.fragments.map(f => f.kind)).toEqual(['where']);
    expect(a.inlinedFunctions).toEqual(['applyFilters']);
    expect(b.inlinedFunctions).toEqual(['applyFilters']);
  });

  test('single-level only: A→B→C short-circuits at B with warning', () => {
    // Wrapper itself calls another wrapper. Depth guard fires at depth=1.
    const decl = scanWithResolver(`
      function inner(q) {
        q = query(q, where("z", "==", 1));
      }
      function outer(q) {
        q = query(q, where("y", "==", 1));
        q = inner(q);
      }
      function fn() {
        let q = query(collection(db, "r"));
        q = outer(q);
      }
    `);
    // outer's own where survives; inner is skipped.
    expect(decl.fragments.map(f => f.filter?.field)).toEqual(['y']);
    expect(decl.inlinedFunctions).toEqual(['outer']);
    expect(decl.interProcWarnings?.[0]).toEqual({
      code: 'inter-proc-recursion',
      functionName: 'inner',
      message: expect.any(String),
    });
  });

  test('chain var via const declaration also triggers inline', () => {
    const decl = scanWithResolver(`
      function applyFilters(q) {
        q = query(q, where("a", "==", 1));
      }
      function fn() {
        const base = query(collection(db, "r"));
        const q = applyFilters(base);
      }
    `);
    // Wrapper call's first arg is `base` (not `q`), so the resolver path
    // doesn't fire from inside the const initializer — this asserts that
    // identifier-name match is strict.
    expect(decl.collectionPath).toBeNull(); // `q` was never assigned `query(collection(...))`
    expect(decl.fragments).toHaveLength(0);
  });
});
