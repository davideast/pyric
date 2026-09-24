/**
 * The served page client's `ref(storage, url)`, replayed against production's
 * `client-storage-ref-urls` capture. Each case in the capture is one `ref()`
 * call; its `input` is passed as given to the worker client's `ref()`.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { getStorage, ref, type ClientFirebaseStorage } from '../../../src/serve/worker/client/storage.js';

interface RefCase {
  input: string;
  parent?: string;
  threw: boolean;
  bucket?: string;
  fullPath?: string;
  name?: string;
  code?: string;
}

const observation = JSON.parse(readFileSync(
  new URL('../../../../conformance/observations/storage/client-storage-ref-urls.json', import.meta.url),
  'utf8',
)) as { behavior: Record<string, RefCase> };
const cases = observation.behavior;

const fakeDb = { __kind: 'client-db' as const, port: {} as never };

function call(storage: ClientFirebaseStorage, recorded: RefCase) {
  return recorded.parent === undefined ? ref(storage, recorded.input) : ref(ref(storage, recorded.parent), recorded.input);
}

/** Replay one recorded `ref()` call and assert its path fields or its error code. */
function expectRefCase(storage: ClientFirebaseStorage, recorded: RefCase): void {
  if (recorded.threw) {
    expect(() => call(storage, recorded)).toThrow(expect.objectContaining({ code: recorded.code }));
    return;
  }
  const made = call(storage, recorded);
  expect({ fullPath: made.fullPath, name: made.name }).toEqual({ fullPath: recorded.fullPath!, name: recorded.name! });
}

describe('served client ref(storage, url)', () => {
  const storage = getStorage(fakeDb);

  test('storage#110: a gs:// URL gives the reference at its path', () => {
    expectRefCase(storage, cases.gsDefaultBucket!);
    expectRefCase(storage, cases.gsPathNotDecoded!);
    expectRefCase(storage, cases.gsBucketRoot!);
    expectRefCase(storage, cases.gsNoBucket!);
    expect(ref(storage, cases.gsDefaultBucket!.input).bucket).toBe(ref(storage, cases.plainPath!.input).bucket);
  });

  test('storage#111: a download URL gives the reference at its decoded path', () => {
    expectRefCase(storage, cases.firebaseDownloadUrl!);
    expectRefCase(storage, cases.firebaseDownloadUrlEncoded!);
    expectRefCase(storage, cases.cloudStorageUrl!);
    expectRefCase(storage, cases.firebaseUrlNoObject!);
  });

  test('storage#112: a URL on another host throws storage/invalid-url', () => {
    expectRefCase(storage, cases.otherHostUrl!);
  });

  test("storage#113: the Node host's download URL (KNOWN DIVERGENCE)", () => {
    // Production throws storage/invalid-url; the client reads the object path
    // from the URL the Node host issues, as production does from its own.
    expect(cases.pyricHostUrl!.code).toBe('storage/invalid-url');
    const made = ref(storage, cases.pyricHostUrl!.input);
    expect({ fullPath: made.fullPath, name: made.name })
      .toEqual({ fullPath: cases.firebaseDownloadUrl!.fullPath!, name: cases.firebaseDownloadUrl!.name! });
  });

  test("storage#114: the reference's bucket (KNOWN DIVERGENCE)", () => {
    // Production gives a reference on the URL's bucket; the host serves one
    // bucket, so the reference is on it, at the URL's path.
    for (const recorded of [cases.gsOtherBucket!, cases.firebaseDownloadUrlOtherBucket!]) {
      expect(recorded.bucket).toBe('other-bucket');
      const made = ref(storage, recorded.input);
      expect(made.bucket).toBe(storage.bucket);
      expect(made.fullPath).toBe(recorded.fullPath!);
    }
  });

  test('storage#115: a data: URI (KNOWN DIVERGENCE)', () => {
    // Production reads a data: URI as an object path; a SharedWorker host's
    // getDownloadURL returns one, so the client throws storage/invalid-url.
    expect(cases.dataUri!.fullPath).toBe(cases.dataUri!.input);
    expect(() => ref(storage, cases.dataUri!.input)).toThrow(expect.objectContaining({ code: 'storage/invalid-url' }));
  });

  test('storage#116: ref(reference, url) throws storage/invalid-argument', () => {
    expectRefCase(storage, cases.childRefWithUrl!);
  });
});
