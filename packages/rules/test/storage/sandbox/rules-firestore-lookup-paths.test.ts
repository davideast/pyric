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
  'num/1.5': { on: true },
  'seed/doc': { f: new RulesFloat(1.5), bareFloat: 1.5, n: 2 },
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

describe('Storage rules lookup paths: numeric interpolation types numbers via rulesInt (#1815)', () => {
  it('interpolationSegments accepts safe-integer numbers and bigints, and rejects bare and wrapped floats', () => {
    expect(interpolationSegments(2)).toEqual(['2']);
    expect(interpolationSegments(2n)).toEqual(['2']);
    expect(interpolationSegments(1.5)).toBeUndefined();
    expect(interpolationSegments(new RulesFloat(1.5))).toBeUndefined();
    expect(interpolationSegments(new RulesFloat(2))).toBeUndefined();
    expect(interpolationSegments(2 ** 53)).toBeUndefined();
    expect(interpolationSegments(Number.NaN)).toBeUndefined();
    expect(interpolationSegments(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('bare float token claim, bare float doc field, wrapped float doc field, and float literal all fail closed alike', () => {
    const byClaim = `match /claim/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/num/$(request.auth.token.v));
    }`;
    const notExistsByClaim = `match /claim/{file} {
      allow create: if !firestore.exists(/databases/(default)/documents/num/$(request.auth.token.v));
    }`;
    const byLiteralFloat = `match /lit/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/num/$(1.5));
    }`;
    const byWrappedDocField = `match /doc/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/num/$(firestore.get(/databases/(default)/documents/seed/doc).data.f));
    }`;
    const byBareDocField = `match /doc/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/num/$(firestore.get(/databases/(default)/documents/seed/doc).data.bareFloat));
    }`;
    const byIntDocField = `match /doc/{file} {
      allow create: if firestore.exists(/databases/(default)/documents/num/$(firestore.get(/databases/(default)/documents/seed/doc).data.n));
    }`;

    expect(upload(byClaim, 'claim/a.bin', {}, { v: 2 })).toBe(true);
    expect(upload(byClaim, 'claim/a.bin', {}, { v: 1.5 })).toBe(false);
    expect(upload(notExistsByClaim, 'claim/a.bin', {}, { v: 1.5 })).toBe(false);
    expect(upload(byLiteralFloat, 'lit/a.bin')).toBe(false);
    expect(upload(byWrappedDocField, 'doc/a.bin')).toBe(false);
    expect(upload(byBareDocField, 'doc/a.bin')).toBe(false);
    expect(upload(byIntDocField, 'doc/a.bin')).toBe(true);
  });
});
