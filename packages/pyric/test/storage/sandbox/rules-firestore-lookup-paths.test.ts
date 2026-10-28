import { describe, expect, it } from 'bun:test';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';

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
};

const lookup = {
  get: (path: string) => docs[path] ?? null,
  exists: (path: string) => path in docs,
};

function upload(rulesBody: string, objectPath: string, metadata: Record<string, string> = {}): boolean {
  const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    ${rulesBody}
  }
}`);
  return evaluateStorageRules(
    rules,
    {
      request: {
        auth: { uid: 'alice' },
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
