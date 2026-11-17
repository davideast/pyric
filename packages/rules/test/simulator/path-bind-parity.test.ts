import { describe, expect, test } from 'bun:test';
import { firestoreRules, lint } from '../../src/index.js';
import { parseStorageRules } from '../../src/storage/rules.js';
import { evaluateStorageRules } from '../../src/storage/rules-evaluator.js';

function evalFirestore(condition: string, matchPath = '/items/{id}', requestPath = 'items/d1') {
  const ruleset = firestoreRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match ${matchPath} {
      allow get: if ${condition};
    }
  }
}`);
  const summary = ruleset.simulate([
    { description: condition, expectation: 'ALLOW', method: 'get', path: requestPath },
  ]);
  const first = summary.cases[0];
  if (!first) throw new Error('expected 1 simulated case');
  return first;
}

function evalStorage(condition: string, matchPath = '/items/{id}', requestPath = 'items/d1') {
  const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match ${matchPath} {
      allow get: if ${condition};
    }
  }
}`);
  return evaluateStorageRules(rules, {
    request: {
      auth: null,
      method: 'get',
      path: `b/default-bucket/o/${requestPath}`,
    },
    resource: null,
  });
}

describe('Cross-engine Path.bind() parity', () => {
  test.each([
    ["path('/a/{x}').bind({'x': '1'}) == path('/a/1')"],
    ["path('/a/{x}').bind({'x': 1.5}) == path('/a/1.5')"],
    ["path('/a/{x}').bind({'x': 1}) == path('/a/1')"],
    ["(/a/{x}).bind({'x': '1'}) == path('/a/1')"],
  ])('allows valid {x} placeholder binding in both engines: %s', (expr) => {
    expect(evalFirestore(expr).decision).toBe('ALLOW');
    expect(evalStorage(expr).allowed).toBe(true);
  });

  test('path("/a/$(x)").bind({"x": "1"}) raises an absorbable missing-template-variable error in both engines', () => {
    const fsDirect = evalFirestore("path('/a/$(x)').bind({'x': '1'}) == path('/a/1')");
    expect(fsDirect.decision).toBe('DENY');
    expect(fsDirect.trace[0]?.verdict).toBe('ERROR');
    expect(fsDirect.trace[0]?.message).toContain('Variable(s) x do not exist in the path template.');

    // Because .bind() errors rather than returning an unchanged path, != and == raw path also deny:
    expect(evalFirestore("path('/a/$(x)').bind({'x': '1'}) != path('/a/1')").decision).toBe('DENY');
    expect(evalFirestore("path('/a/$(x)').bind({'x': '1'}) == path('/a/$(x)')").decision).toBe('DENY');
    expect(evalFirestore("(path('/a/$(x)').bind({'x': '1'}) == path('/a/1')) || true").decision).toBe('ALLOW');
    expect(evalFirestore("!((path('/a/$(x)').bind({'x': '1'}) == path('/a/1')) && false)").decision).toBe('ALLOW');

    const stDirect = evalStorage("path('/a/$(x)').bind({'x': '1'}) == path('/a/1')");
    expect(stDirect.allowed).toBe(false);
    expect(stDirect.reasons.join(' ')).toContain('Variable(s) x do not exist in the path template.');

    expect(evalStorage("path('/a/$(x)').bind({'x': '1'}) != path('/a/1')").allowed).toBe(false);
    expect(evalStorage("path('/a/$(x)').bind({'x': '1'}) == path('/a/$(x)')").allowed).toBe(false);
    expect(evalStorage("(path('/a/$(x)').bind({'x': '1'}) == path('/a/1')) || true").allowed).toBe(true);
    expect(evalStorage("!((path('/a/$(x)').bind({'x': '1'}) == path('/a/1')) && false)").allowed).toBe(true);
  });

  test('(/a/$(x)).bind({"x": "1"}) with bound wildcard x="orig" interpolates first and raises missing-template-variable error', () => {
    const fsRes = evalFirestore("(/a/$(x)).bind({'x': '1'}) == path('/a/1')", '/items/{x}', 'items/orig');
    expect(fsRes.decision).toBe('DENY');
    expect(fsRes.trace[0]?.verdict).toBe('ERROR');
    expect(fsRes.trace[0]?.message).toContain('Variable(s) x do not exist in the path template.');
    expect(evalFirestore("(/a/$(x)).bind({'x': '1'}) == path('/a/orig')", '/items/{x}', 'items/orig').decision).toBe('DENY');
    expect(evalFirestore("(/a/$(x)).bind({'x': '1'}) != path('/a/1')", '/items/{x}', 'items/orig').decision).toBe('DENY');
    expect(evalFirestore("((/a/$(x)).bind({'x': '1'}) == path('/a/1')) || true", '/items/{x}', 'items/orig').decision).toBe('ALLOW');

    const stRes = evalStorage("(/a/$(x)).bind({'x': '1'}) == path('/a/1')", '/items/{x}', 'items/orig');
    expect(stRes.allowed).toBe(false);
    expect(stRes.reasons.join(' ')).toContain('Variable(s) x do not exist in the path template.');
    expect(evalStorage("(/a/$(x)).bind({'x': '1'}) == path('/a/orig')", '/items/{x}', 'items/orig').allowed).toBe(false);
    expect(evalStorage("(/a/$(x)).bind({'x': '1'}) != path('/a/1')", '/items/{x}', 'items/orig').allowed).toBe(false);
    expect(evalStorage("((/a/$(x)).bind({'x': '1'}) == path('/a/1')) || true", '/items/{x}', 'items/orig').allowed).toBe(true);
  });

  test('(/a/$(x)).bind({"x": "1"}) with unbound x compiles cleanly and raises an absorbable runtime error', () => {
    expect(evalFirestore("(/a/$(x)).bind({'x': '1'}) == path('/a/1')").decision).toBe('DENY');
    expect(evalFirestore("((/a/$(x)).bind({'x': '1'}) == path('/a/1')) || true").decision).toBe('ALLOW');

    expect(evalStorage("(/a/$(x)).bind({'x': '1'}) == path('/a/1')").allowed).toBe(false);
    expect(evalStorage("((/a/$(x)).bind({'x': '1'}) == path('/a/1')) || true").allowed).toBe(true);
  });

  test('lint() and firestoreRules().lint() accept {x} placeholders on (/a/{x}).bind(...) while still flagging unbound lookup paths', () => {
    const validBindRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow get: if request.auth != null && (/a/{x}).bind({'x': '1'}) == path('/a/1');
    }
  }
}`;
    expect(lint(validBindRules).filter((i) => i.code === 'INVALID_PATH_INTERPOLATION')).toEqual([]);
    expect(firestoreRules(validBindRules).lint().filter((i) => i.code === 'INVALID_PATH_INTERPOLATION')).toEqual([]);

    const uninterpolatedLookup = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow get: if request.auth != null && exists(/databases/{database}/documents/items/{id});
    }
  }
}`;
    expect(lint(uninterpolatedLookup).filter((i) => i.code === 'INVALID_PATH_INTERPOLATION')).toHaveLength(2);
  });
});
