import { describe, expect, it } from 'bun:test';
import { RulesFloat } from '../../../src/simulator/wrappers/float.js';
import { parseStorageRules } from '../../../src/storage/rules.js';
import { evaluateStorageRules } from '../../../src/storage/rules-evaluator.js';
import { interpolationSegments } from '../../../src/storage/rules-path.js';

// How an interpolated value becomes segments of a `firestore.get()` or
// `firestore.exists()` document path. Production keeps a string as one
// segment, whatever it contains, and splices a path value in as its segments.
// Captures: `rules-storage-h1-lookup-interpolated-slash` (row storage-rules#212)
// and `rules-storage-storage-lookup-path-interpolation` (row storage-rules#215).

const docs: Record<string, Record<string, unknown>> = {
  'users/alice': { admin: true },
  'users/alice/private/x': { admin: true },
  'col/a': { on: true },
  'col/a/b/c': { on: true },
  'num/2': { on: true },
  'num/2.0': { on: true },
  'num/0': { on: true },
  'num/0.0': { on: true },
  'num/-0.0': { on: true },
  'num/1.5': { on: true },
  'num/-1.5': { on: true },
  'num/5.0E-4': { on: true },
  'num/1.0E-7': { on: true },
  'num/1.00000005E7': { on: true },
  'num/1.0E21': { on: true },
  'num/9007199254740992': { on: true },
  'num/9.007199254740992E15': { on: true },
  'num/NaN': { on: true },
  'num/Infinity': { on: true },
  'num/-Infinity': { on: true },
  'seed/doc': {
    f: new RulesFloat(1.5),
    bareFloat: 1.5,
    intFloat: new RulesFloat(2),
    smallFloat: 0.0005,
    largeFloat: 10000000.5,
    negZeroFloat: new RulesFloat(-0),
    bigIntField: 9007199254740992n,
    bigFloatField: 2 ** 53,
    n: 2,
  },
};

const lookup = {
  get: (path: string) => docs[path] ?? null,
  exists: (path: string) => path in docs,
};

function upload(
  rulesBody: string,
  objectPath: string,
  metadata: Record<string, string> = {},
  token?: Record<string, unknown>,
): boolean {
  const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    ${rulesBody}
  }
}`);
  const auth = token === undefined ? { uid: 'alice' } : { uid: 'alice', token };
  return evaluateStorageRules(
    rules,
    {
      request: {
        auth,
        method: 'create',
        path: `b/pyric-default/o/${objectPath}`,
        resource: { size: 1, metadata },
      },
      resource: null,
    },
    undefined,
    lookup,
  ).allowed;
}

const getByUid = `match /lk/{file} {
      allow create: if firestore.get(/databases/(default)/documents/users/$(request.resource.metadata.uid)).data.admin == true;
    }`;
const existsByUid = `match /lk/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/users/$(request.resource.metadata.uid));
    }`;
const notExistsByUid = `match /lk/{file} {
      allow create: if !firestore.exists(/databases/(default)/documents/users/$(request.resource.metadata.uid));
    }`;

describe('Storage rules lookup paths: an interpolated string is one segment', () => {
  it('get denies when the interpolated string holds a slash', () => {
    expect(upload(getByUid, 'lk/a.bin', { uid: 'alice/private/x' })).toBe(false);
  });

  it('exists denies when the interpolated string holds a slash', () => {
    expect(upload(existsByUid, 'lk/a.bin', { uid: 'alice/private/x' })).toBe(false);
  });

  // Inferred, not captured: the capture ran under the Rules Test API, where an
  // unmocked call also errors, so it cannot show `exists` answering false
  // against a real database. Erroring is the fail-closed reading.
  it('a negated exists still denies, since the lookup errors rather than returning false', () => {
    expect(upload(notExistsByUid, 'lk/a.bin', { uid: 'alice/private/x' })).toBe(false);
  });

  it('a plain interpolated id still reads its document', () => {
    expect(upload(getByUid, 'lk/a.bin', { uid: 'alice' })).toBe(true);
    expect(upload(existsByUid, 'lk/a.bin', { uid: 'alice' })).toBe(true);
  });

  it('a literal deeper path still reads the deeper document', () => {
    const literal = `match /lk/{file} {
      allow create: if firestore.get(/databases/(default)/documents/users/alice/private/x).data.admin == true;
    }`;
    expect(upload(literal, 'lk/a.bin')).toBe(true);
  });
});

describe('Storage rules lookup paths: a path value splices in its segments', () => {
  const byRest = `match /one/{rest=**} {
      allow create: if firestore.exists(/databases/(default)/documents/col/$(rest));
    }`;
  const byRestString = `match /str/{rest=**} {
      allow create: if firestore.exists(/databases/(default)/documents/col/$(string(rest)));
    }`;

  it('a single-segment {rest=**} capture reads col/a', () => {
    expect(upload(byRest, 'one/a')).toBe(true);
  });

  it('a three-segment {rest=**} capture reads col/a/b/c', () => {
    expect(upload(byRest, 'one/a/b/c')).toBe(true);
  });

  it('string() of a capture is one segment with a leading slash, and denies', () => {
    expect(upload(byRestString, 'str/a')).toBe(false);
    expect(upload(byRestString, 'str/a/b')).toBe(false);
  });

  it('a path() value interpolated mid-path splices its segments', () => {
    const viaPathFn = `match /p/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/$(path('col/a/b/c')));
    }`;
    expect(upload(viaPathFn, 'p/x.bin')).toBe(true);
  });
});

// A path literal built outside the lookup call, such as in a helper function,
// keeps the same segments as the direct argument (#1403). No capture covers
// the function-built path; a path literal is one construct wherever it
// appears, so it follows the direct-argument capture.
describe('Storage rules lookup paths: a path literal built in a helper function', () => {
  const getViaHelper = `function userDoc(uid) { return /databases/(default)/documents/users/$(uid); }
    match /lk/{file} {
      allow create: if firestore.get(userDoc(request.resource.metadata.uid)).data.admin == true;
    }`;
  const existsViaHelper = `function userDoc(uid) { return /databases/(default)/documents/users/$(uid); }
    match /lk/{file} {
      allow create: if firestore.exists(userDoc(request.resource.metadata.uid));
    }`;

  it('get denies when the interpolated string holds a slash', () => {
    expect(upload(getViaHelper, 'lk/a.bin', { uid: 'alice/private/x' })).toBe(false);
  });

  it('exists denies when the interpolated string holds a slash', () => {
    expect(upload(existsViaHelper, 'lk/a.bin', { uid: 'alice/private/x' })).toBe(false);
  });

  it('a plain interpolated id still reads its document', () => {
    expect(upload(getViaHelper, 'lk/a.bin', { uid: 'alice' })).toBe(true);
  });

  it('an interpolated path value splices in its segments', () => {
    const viaRest = `function colDoc(rest) { return /databases/(default)/documents/col/$(rest); }
    match /one/{rest=**} {
      allow create: if firestore.exists(colDoc(rest));
    }`;
    expect(upload(viaRest, 'one/a/b/c')).toBe(true);
  });
});

describe('Storage rules lookup paths: numeric interpolation formats ints and floats via Java Double.toString (#1815)', () => {
  it('interpolationSegments formats ints as decimal digits and bare or wrapped floats via formatRulesFloat', () => {
    expect(interpolationSegments(2)).toEqual(['2']);
    expect(interpolationSegments(2n)).toEqual(['2']);
    expect(interpolationSegments(9007199254740992n)).toEqual(['9007199254740992']);
    expect(interpolationSegments(0)).toEqual(['0']);
    expect(interpolationSegments(1.5)).toEqual(['1.5']);
    expect(interpolationSegments(new RulesFloat(1.5))).toEqual(['1.5']);
    expect(interpolationSegments(-1.5)).toEqual(['-1.5']);
    expect(interpolationSegments(new RulesFloat(-1.5))).toEqual(['-1.5']);
    expect(interpolationSegments(0.001)).toEqual(['0.001']);
    expect(interpolationSegments(new RulesFloat(9999999.5))).toEqual(['9999999.5']);
    expect(interpolationSegments(new RulesFloat(2))).toEqual(['2.0']);
    expect(interpolationSegments(new RulesFloat(0))).toEqual(['0.0']);
    expect(interpolationSegments(-0)).toEqual(['-0.0']);
    expect(interpolationSegments(new RulesFloat(-0))).toEqual(['-0.0']);
    expect(interpolationSegments(2 ** 53)).toEqual(['9.007199254740992E15']);
    expect(interpolationSegments(new RulesFloat(2 ** 53))).toEqual(['9.007199254740992E15']);
    expect(interpolationSegments(0.0005)).toEqual(['5.0E-4']);
    expect(interpolationSegments(new RulesFloat(0.0005))).toEqual(['5.0E-4']);
    expect(interpolationSegments(1e-7)).toEqual(['1.0E-7']);
    expect(interpolationSegments(new RulesFloat(1e-7))).toEqual(['1.0E-7']);
    expect(interpolationSegments(10000000.5)).toEqual(['1.00000005E7']);
    expect(interpolationSegments(new RulesFloat(10000000.5))).toEqual(['1.00000005E7']);
    expect(interpolationSegments(1e21)).toEqual(['1.0E21']);
    expect(interpolationSegments(new RulesFloat(1e21))).toEqual(['1.0E21']);
    expect(interpolationSegments(Number.NaN)).toEqual(['NaN']);
    expect(interpolationSegments(new RulesFloat(Number.NaN))).toEqual(['NaN']);
    expect(interpolationSegments(Number.POSITIVE_INFINITY)).toEqual(['Infinity']);
    expect(interpolationSegments(Number.NEGATIVE_INFINITY)).toEqual(['-Infinity']);
    expect(interpolationSegments(new RulesFloat(Number.POSITIVE_INFINITY))).toEqual(['Infinity']);
    expect(interpolationSegments(new RulesFloat(Number.NEGATIVE_INFINITY))).toEqual(['-Infinity']);
  });

  it('interpolationSegments still rejects booleans, null, undefined, arrays, and plain objects', () => {
    expect(interpolationSegments(true)).toBeUndefined();
    expect(interpolationSegments(false)).toBeUndefined();
    expect(interpolationSegments(null)).toBeUndefined();
    expect(interpolationSegments(undefined)).toBeUndefined();
    expect(interpolationSegments([])).toBeUndefined();
    expect(interpolationSegments({})).toBeUndefined();
  });

  it('matches captured production Java Double.toString segments across claims, fields, literals, and casts', () => {
    const getByClaim = `match /claim/{file} {
      allow create: if firestore.get(/databases/(default)/documents/num/$(request.auth.token.v)).data.on == true;
    }`;
    const existsByClaim = `match /claim/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/num/$(request.auth.token.v));
    }`;
    const notExistsByClaim = `match /claim/{file} {
      allow create: if !firestore.exists(/databases/(default)/documents/num/$(request.auth.token.v));
    }`;
    const getByWrappedDocField = `match /doc/{file} {
      allow create: if firestore.get(/databases/(default)/documents/num/$(firestore.get(/databases/(default)/documents/seed/doc).data.f)).data.on == true;
    }`;
    const existsByWrappedDocField = `match /doc/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/num/$(firestore.get(/databases/(default)/documents/seed/doc).data.f));
    }`;
    const existsByBareDocField = `match /doc/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/num/$(firestore.get(/databases/(default)/documents/seed/doc).data.bareFloat));
    }`;
    const existsByIntDocField = `match /doc/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/num/$(firestore.get(/databases/(default)/documents/seed/doc).data.n));
    }`;
    const existsByLiteralFloat = `match /lit/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/num/$(1.5));
    }`;
    const existsIntegralFloatLiteral = `match /lit/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/num/$(2.0));
    }`;
    const existsNegativeZeroLiteral = `match /lit/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/num/$(-0.0));
    }`;
    const existsIntegralFloatDocField = `match /doc/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/num/$(firestore.get(/databases/(default)/documents/seed/doc).data.intFloat));
    }`;
    const existsSmallFloatDocField = `match /doc/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/num/$(firestore.get(/databases/(default)/documents/seed/doc).data.smallFloat));
    }`;
    const existsLargeFloatDocField = `match /doc/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/num/$(firestore.get(/databases/(default)/documents/seed/doc).data.largeFloat));
    }`;
    const existsBigIntDocField = `match /doc/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/num/$(firestore.get(/databases/(default)/documents/seed/doc).data.bigIntField));
    }`;
    const existsBigFloatDocField = `match /doc/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/num/$(firestore.get(/databases/(default)/documents/seed/doc).data.bigFloatField));
    }`;
    const existsNanCast = `match /lit/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/num/$(float('NaN')));
    }`;
    const existsInfinityCast = `match /lit/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/num/$(float('Infinity')));
    }`;
    const existsNegInfinityCast = `match /lit/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/num/$(float('-Infinity')));
    }`;

    expect(upload(getByClaim, 'claim/a.bin', {}, { v: 2 })).toBe(true);
    expect(upload(getByClaim, 'claim/a.bin', {}, { v: 1.5 })).toBe(true);
    expect(upload(existsByClaim, 'claim/a.bin', {}, { v: 1.5 })).toBe(true);
    expect(upload(existsByClaim, 'claim/a.bin', {}, { v: -1.5 })).toBe(true);
    expect(upload(existsByClaim, 'claim/a.bin', {}, { v: 2.5 })).toBe(false);
    expect(upload(notExistsByClaim, 'claim/a.bin', {}, { v: 2.5 })).toBe(true);
    expect(upload(getByWrappedDocField, 'doc/a.bin')).toBe(true);
    expect(upload(existsByWrappedDocField, 'doc/a.bin')).toBe(true);
    expect(upload(existsByBareDocField, 'doc/a.bin')).toBe(true);
    expect(upload(existsByIntDocField, 'doc/a.bin')).toBe(true);
    expect(upload(existsByLiteralFloat, 'lit/a.bin')).toBe(true);

    // Production formats floats with Java Double.toString: 5.0E-4, 1.00000005E7,
    // 2.0, -0.0, NaN, Infinity, -Infinity.
    expect(upload(existsByClaim, 'claim/a.bin', {}, { v: 0.0005 })).toBe(true);
    expect(upload(existsByClaim, 'claim/a.bin', {}, { v: 10000000.5 })).toBe(true);
    expect(upload(existsByClaim, 'claim/a.bin', {}, { v: 1e21 })).toBe(true);
    expect(upload(existsByClaim, 'claim/a.bin', {}, { v: 9007199254740992 })).toBe(true);
    expect(upload(existsIntegralFloatLiteral, 'lit/a.bin')).toBe(true);
    expect(upload(existsNegativeZeroLiteral, 'lit/a.bin')).toBe(true);
    expect(upload(existsIntegralFloatDocField, 'doc/a.bin')).toBe(true);
    expect(upload(existsSmallFloatDocField, 'doc/a.bin')).toBe(true);
    expect(upload(existsLargeFloatDocField, 'doc/a.bin')).toBe(true);
    expect(upload(existsBigIntDocField, 'doc/a.bin')).toBe(true);
    expect(upload(existsBigFloatDocField, 'doc/a.bin')).toBe(true);
    expect(upload(existsNanCast, 'lit/a.bin')).toBe(true);
    expect(upload(existsInfinityCast, 'lit/a.bin')).toBe(true);
    expect(upload(existsNegInfinityCast, 'lit/a.bin')).toBe(true);

    // Non-string/non-numeric/non-path types still error and deny even under `!exists(...)`.
    expect(upload(existsByClaim, 'claim/a.bin', {}, { v: true })).toBe(false);
    expect(upload(notExistsByClaim, 'claim/a.bin', {}, { v: true })).toBe(false);
    expect(upload(notExistsByClaim, 'claim/a.bin', {}, { v: null })).toBe(false);
  });
});
