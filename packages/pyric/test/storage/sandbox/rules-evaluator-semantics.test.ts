import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStorageRules, type StorageRequestMethod } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';
import { StoragePath } from '../../../src/storage/sandbox/rules-path.js';
import {
  OBSERVATION_NAME,
  probePath,
  requestResourceRules,
} from '../../../../conformance/src/storage-request-resource-probes.ts';

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

/** Production's verdicts for uploads over a stored object, from the committed capture. */
function overwriteVerdicts(): Record<string, 'ALLOW' | 'DENY'> {
  const file = join(
    import.meta.dir, '..', '..', '..', '..', 'conformance', 'observations', 'storage-rules', `${OBSERVATION_NAME}.json`,
  );
  return JSON.parse(readFileSync(file, 'utf8')).behavior.overwrite;
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

  it('binds a coarse write with a payload to create or update, never delete', () => {
    const rules = rulesFor('write', "request.method == 'delete' || request.resource.size < 100");
    const write = (size: number) => evaluateStorageRules(rules, {
      request: { auth: { uid: 'alice' }, method: 'write', path, resource: { size } },
      resource: null,
    });
    expect(write(1000).allowed).toBe(false);
    expect(write(10).allowed).toBe(true);
    expect(evaluate('write', "request.method == 'update'", 'write').allowed).toBe(false);
  });

  // A coarse write over no stored object is a create: production has no
  // object to update, so an `update` arm can't admit an oversized upload.
  it('binds a coarse write with a payload and no stored object to create only', () => {
    const rules = rulesFor('write', "request.method == 'update' || request.resource.size < 10 * 1024 * 1024");
    const write = (size: number) => evaluateStorageRules(rules, {
      request: { auth: { uid: 'alice' }, method: 'write', path, resource: { size } },
      resource: null,
    });
    expect(write(20 * 1024 * 1024).allowed).toBe(false);
    expect(write(10).allowed).toBe(true);
  });

  // A coarse write with a payload over a stored object is an upload over
  // it, and production checks that upload as a create (#1884), so an
  // `update` arm can't admit an oversized overwrite.
  it('binds a coarse write with a payload over a stored object to create only', () => {
    const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{docId} {
      allow create: if request.resource.size < 10 * 1024 * 1024;
      allow update: if true;
    }
  }
}`);
    const write = (size: number) => evaluateStorageRules(rules, {
      request: { auth: { uid: 'alice' }, method: 'write', path, resource: { size } },
      resource: { size: 1 },
    });
    expect(write(50 * 1024 * 1024).allowed).toBe(false);
    expect(write(10).allowed).toBe(true);
  });

  // `stdlib-realstorage-request-resource-fields` deploys these probes to a
  // real bucket and uploads 6 bytes over a stored 5-byte object at each
  // path. A coarse write with that payload over that object must match
  // production's verdict for the upload.
  it.each(['verb-create', 'verb-update', 'create-stored-and-new-size', 'resource-existing'])(
    'matches production for a coarse write over a stored object: overwrite/%s',
    (id) => {
      const prefix = 'replay/request-resource';
      const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {${requestResourceRules(prefix)}  }
}`);
      const r = evaluateStorageRules(rules, {
        request: {
          auth: null,
          method: 'write',
          path: `b/pyric-default/o/${probePath(prefix, 'overwrite', id)}`,
          resource: { size: 6 },
        },
        resource: { size: 5 },
      });
      expect(r.allowed ? 'ALLOW' : 'DENY').toBe(overwriteVerdicts()[id]!);
    },
  );

  it('applies only the grants for the verb a coarse write binds', () => {
    const rules = rulesFor('delete', 'true');
    const write = (resource: { size: number } | null) => evaluateStorageRules(rules, {
      request: { auth: { uid: 'alice' }, method: 'write', path, resource: { size: 20 * 1024 * 1024 } },
      resource,
    });
    expect(write(null).allowed).toBe(false);
    expect(write({ size: 1 }).allowed).toBe(false);
    expect(evaluate('delete', 'true', 'write').allowed).toBe(true);
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

describe('evaluateStorageRules: path segments survive bind()', () => {
  it('keeps a bound value with a slash as one segment', () => {
    const bound = new StoragePath('/users/{uid}').bind({ uid: 'a/b' });
    expect(bound.segments).toEqual(['users', 'a/b']);
    expect(bound.bind({}).segments).toEqual(['users', 'a/b']);
  });

  it('reads the kept segment by index in a rule', () => {
    expect(evaluate('read', "path('/users/{uid}').bind({'uid': 'a/b'})[1] == 'a/b'").allowed).toBe(true);
    expect(evaluate('read', "path('/users/{uid}').bind({'uid': 'a/b'})[2] == 'b'").allowed).toBe(false);
  });
});
