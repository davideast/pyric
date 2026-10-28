import { describe, it, expect } from 'bun:test';
import { parseStorageRules, type StorageRequestMethod } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';

// Storage evaluator semantics that production and the Firestore engine
// share: unknown methods are absorbable errors, a coarse request binds each
// granular `request.method`, the evaluation instant is a real time, and a
// duration negates (#1343).

const path = 'b/pyric-default/o/docs/d1.json';

function rulesFor(verb: string, cond: string) {
  return parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{docId} { allow ${verb}: if ${cond}; }
  }
}`);
}

function evaluate(verb: string, cond: string, method: StorageRequestMethod = 'get') {
  return evaluateStorageRules(rulesFor(verb, cond), {
    request: { auth: { uid: 'alice' }, method, path },
    resource: { size: 10 },
  });
}

describe('evaluateStorageRules: unknown methods', () => {
  it.each([
    ["'a'.foo() || true"],
    ["!('a'.foo() == 1 && false)"],
    ["{'abs': 1}.abs() == 1 || true"],
    ['[1, 2].indexOf(2) == 1 || true'],
  ])('absorbs an unknown method under a determining operand: %s', (cond) => {
    expect(evaluate('read', cond).allowed).toBe(true);
  });

  it("denies an unknown method alone with production's function-not-found text", () => {
    const r = evaluate('read', "'a'.foo() == 'a'");
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('Function not found error: Name: [foo].');
  });

  it('propagates an error receiver rather than recasting it', () => {
    const r = evaluate('read', 'resource.missing.foo() == 1');
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).not.toContain('Name: [foo]');
  });
});

describe('evaluateStorageRules: coarse requests bind granular methods', () => {
  it("allows a coarse write that a `request.method == 'create'` grant admits", () => {
    const r = evaluateStorageRules(rulesFor('write', "request.method == 'create'"), {
      request: { auth: { uid: 'alice' }, method: 'write', path, resource: { size: 10 } },
      resource: null,
    });
    expect(r.allowed).toBe(true);
  });

  it('allows a coarse read that a list-only condition admits', () => {
    expect(evaluate('read', "request.method == 'list'", 'read').allowed).toBe(true);
  });

  it('never binds the coarse word itself', () => {
    expect(evaluate('write', "request.method == 'write'", 'write').allowed).toBe(false);
    expect(evaluate('read', "request.method == 'read'", 'read').allowed).toBe(false);
  });

  it('binds a coarse write with a payload to create and update, never delete', () => {
    const rules = rulesFor('write', "request.method == 'delete' || request.resource.size < 100");
    const write = (size: number) => evaluateStorageRules(rules, {
      request: { auth: { uid: 'alice' }, method: 'write', path, resource: { size } },
      resource: null,
    });
    expect(write(1000).allowed).toBe(false);
    expect(write(10).allowed).toBe(true);
    expect(evaluate('write', "request.method == 'update'", 'write').allowed).toBe(false);
  });

  it('binds a coarse write without a payload to delete', () => {
    expect(evaluate('write', "request.method == 'delete'", 'write').allowed).toBe(true);
    expect(evaluate('write', "request.method == 'create'", 'write').allowed).toBe(false);
  });

  it("reports the last denial's reasons and count, not a sum", () => {
    const rules = rulesFor('read', "request.method == 'never'");
    const one = evaluateStorageRules(rules, { request: { auth: null, method: 'get', path }, resource: null });
    const coarse = evaluateStorageRules(rules, { request: { auth: null, method: 'read', path }, resource: null });
    expect(coarse.evaluatedExpressions).toBe(one.evaluatedExpressions);
    expect(coarse.reasons.length).toBe(one.reasons.length);
  });

  it('keeps a granular request bound to its own verb', () => {
    expect(evaluate('write', "request.method == 'update'", 'update').allowed).toBe(true);
    expect(evaluate('write', "request.method == 'create'", 'update').allowed).toBe(false);
  });
});

describe('evaluateStorageRules: the evaluation instant', () => {
  it('refuses an Invalid Date now', () => {
    const rules = rulesFor('read', 'true');
    const input = { request: { auth: null, method: 'get' as const, path }, resource: null };
    expect(() => evaluateStorageRules(rules, input, new Date(Number.NaN))).toThrow(
      new TypeError('evaluateStorageRules: now must be a valid Date'),
    );
  });

  it('keeps the clock when the caller passes no now', () => {
    expect(evaluate('read', 'request.time > timestamp.date(2020, 1, 1)').allowed).toBe(true);
  });
});

describe('evaluateStorageRules: unary minus on a duration', () => {
  it('negates the duration', () => {
    expect(evaluate('read', "-duration.value(1, 's') == duration.value(-1, 's')").allowed).toBe(true);
    expect(evaluate('read', "-duration.value(1, 's') < duration.value(0, 's')").allowed).toBe(true);
    expect(evaluate('read', "-(-duration.value(1500, 'ms')) == duration.value(1500, 'ms')").allowed).toBe(true);
  });
});
