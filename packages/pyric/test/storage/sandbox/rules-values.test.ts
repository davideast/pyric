import { describe, it, expect } from 'bun:test';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';

describe('production-pinned JS-semantics guards (no false-allow via JS leakage)', () => {
  /** One-condition harness: evaluate `if <cond>` for a create of a-b-c.png. */
  const verdict = (cond: string, path = 'x/a-b-c.png') => {
    const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /x/{fileId} {
      allow create: if ${cond};
    }
  }
}`);
    return evaluateStorageRules(rules, {
      request: {
        auth: { uid: 'a' },
        method: 'create',
        path: `/b/b1/o/${path}`,
        resource: { size: 100, contentType: 'image/png', metadata: { owner: 'a' } },
      },
      resource: null,
    }).allowed;
  };

  /** The regression this guards: JS `in` walks the prototype chain, so
   *  `'toString' in map` would be TRUE → ALLOW; production maps expose own
   *  keys only (pinned by rules-firestore-prototype-chain-keys). */
  it('`in` on maps tests own keys only — prototype names are not keys', () => {
    expect(verdict(`'toString' in request.resource.metadata`)).toBe(false);
    expect(verdict(`'constructor' in {'a': 1}`)).toBe(false);
    expect(verdict(`!('hasOwnProperty' in request.resource.metadata)`)).toBe(true);
    expect(verdict(`'owner' in request.resource.metadata`)).toBe(true);
  });

  /** The regression this guards: JS division by zero yields Infinity, and
   *  `Infinity > n` is TRUE → ALLOW; production errors (denies), while
   *  `error || true` still absorbs to allow. */
  it('division/modulo by zero errors and denies, absorbable by ||', () => {
    expect(verdict('request.resource.size / 0 > 5')).toBe(false);
    expect(verdict('request.resource.size % 0 == 0')).toBe(false);
    expect(verdict('(request.resource.size / 0 == 0) ? true : true')).toBe(false);
    expect(verdict('(request.resource.size / 0 == 0) || true')).toBe(true);
  });

  /** The regression this guards: JS `.slice()` clamps out-of-range bounds;
   *  production errors (pinned by rules-firestore-range-slice-list-and-string:
   *  an end past length denies). */
  it('out-of-range slice bounds error and deny instead of clamping', () => {
    expect(verdict(`fileId.split('-')[0:2].size() == 2`)).toBe(true);
    expect(verdict(`fileId.split('-')[0:9].size() >= 0`)).toBe(false);
    expect(verdict(`'abcdef'[1:4] == 'bcd'`)).toBe(true);
    expect(verdict(`'abc'[1:9].size() >= 0`)).toBe(false);
  });

  /** The regression this guards: `===` on arrays/maps is reference identity,
   *  so a slice or literal could never equal another literal (false-DENY),
   *  and `!=` would false-ALLOW; production compares structurally. */
  it('lists and maps compare structurally under == / !=', () => {
    expect(verdict(`fileId.split('-')[0:2] == ['a', 'b']`)).toBe(true);
    expect(verdict(`['a', 'b'] != ['a', 'b']`)).toBe(false);
    expect(verdict(`{'k': 1} == {'k': 1}`)).toBe(true);
    expect(verdict(`{'k': 1} == {'k': 2}`)).toBe(false);
  });

  it('split() rejects RE2-unsupported constructs with a deny-reason', () => {
    expect(verdict(`fileId.split('(?=x)').size() > 0`)).toBe(false);
  });

  it('size() covers strings, lists, and map own-keys', () => {
    expect(verdict(`'abc'.size() == 3`)).toBe(true);
    expect(verdict(`request.resource.metadata.size() == 1`)).toBe(true);
    expect(verdict(`request.resource.size.size() > 0`)).toBe(false);
  });
});

describe('int/float literal typing (RULES-B5 float model)', () => {
  const verdict = (cond: string) => {
    const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /x/{fileId} {
      allow create: if ${cond};
    }
  }
}`);
    return evaluateStorageRules(rules, {
      request: {
        auth: { uid: 'a' },
        method: 'create',
        path: '/b/b1/o/x/f.png',
        resource: { size: 100, contentType: 'image/png' },
      },
      resource: null,
    }).allowed;
  };

  /** The regression this guards: JS numbers carry no int/float distinction,
   *  so a value-typed `is` called `1.0` an int and int division produced
   *  2.5 — production types by literal form and truncates int ÷ int
   *  (pinned by oracle:rules-storage-type-checks-is and
   *  oracle:rules-storage-float-modulo-unary-minus). */
  it('types numeric literals by form: 1.0 is float, 1 is int', () => {
    expect(verdict('1.0 is float')).toBe(true);
    expect(verdict('1 is int')).toBe(true);
    expect(verdict('1.0 is int')).toBe(false);
    expect(verdict('1 is float')).toBe(false);
  });

  it('int / int truncates toward zero; float division stays float', () => {
    expect(verdict('10 / 4 == 2')).toBe(true);
    expect(verdict('-7 / 2 == -3')).toBe(true);
    expect(verdict('10.0 / 4.0 == 2.5')).toBe(true);
    expect(verdict('10 / 4.0 == 2.5')).toBe(true);
  });

  it('int and float compare by numeric value across the tag', () => {
    expect(verdict('1 == 1.0')).toBe(true);
    expect(verdict('1 < 1.5')).toBe(true);
    expect(verdict('request.resource.size * 0.5 == 50.0')).toBe(true);
    expect(verdict('-(1.5) is float')).toBe(true);
  });
});

describe('late-failure deny reasons name the construct (parse-time → request-time shift)', () => {
  /** Constructs the shared grammar parses but the evaluator does not model
   *  fail at REQUEST time, not parse time. The deny reason must name the
   *  construct so the late failure is diagnosable from the reason trace. */
  const reasons = (rules: string, method: 'get' | 'create' = 'get') => {
    const parsed = parseStorageRules(rules);
    const res = evaluateStorageRules(parsed, {
      request: {
        auth: { uid: 'a' },
        method,
        path: '/b/b1/o/x/f.png',
        resource: method === 'create' ? { size: 1, contentType: 'image/png' } : undefined,
      },
      resource: method === 'get' ? { size: 1 } : null,
    });
    expect(res.allowed).toBe(false);
    return res.reasons.join(' ');
  };

  it('an imported function call names the import and its module', () => {
    expect(
      reasons(`rules_version = '2+modules';
import { isAdmin } from 'shared/helpers';
service firebase.storage {
  match /b/{bucket}/o {
    match /x/{fileId} {
      allow read: if isAdmin(request.auth);
    }
  }
}`),
    ).toMatch(/isAdmin\(\) is imported from 'shared\/helpers', but import module resolution is not implemented/);
  });

  it('a locally declared function shadows an imported name and evaluates', () => {
    const parsed = parseStorageRules(`rules_version = '2';
import { isAdmin } from 'shared/helpers';
function isAdmin(auth) {
  return auth != null;
}
service firebase.storage {
  match /b/{bucket}/o {
    match /x/{fileId} {
      allow read: if isAdmin(request.auth);
    }
  }
}`);
    const res = evaluateStorageRules(parsed, {
      request: { auth: { uid: 'a' }, method: 'get', path: '/b/b1/o/x/f.png' },
      resource: { size: 1 },
    });
    expect(res.allowed).toBe(true);
  });

  it('an unsupported builtin method names the method', () => {
    expect(
      reasons(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /x/{fileId} {
      allow read: if fileId.upper() == 'F.PNG';
    }
  }
}`),
    ).toMatch(/unsupported method \.upper\(\)/);
  });

  it('an unmodeled `is` type names the type', () => {
    expect(
      reasons(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /x/{fileId} {
      allow read: if request.time is timestamp;
    }
  }
}`),
    ).toMatch(/'is timestamp' is not supported by the storage evaluator/);
  });
});
