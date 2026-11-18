/**
 * Oracle conformance — wires `packages/conformance/observations/storage/storage-*.json`
 * into the test suite so the captured real-Firebase-Storage behavior is
 * MACHINE-CHECKED against the sandbox shim, not just cited in comments
 * (mirrors the auth suite at `test/auth/oracle-conformance.test.ts`, which
 * closed the same gap for auth — see that file's header for the H5/H6
 * rationale).
 *
 * Pattern: each test loads its observation and replays the scenario
 * against the sandbox storage surface, asserting the environment-
 * independent facts the capture recorded (error codes, counts, shapes,
 * booleans, orderings). The JSON's values are the EXPECTED side wherever
 * sensible — if a capture is re-run against prod and a value changes, the
 * test fails and surfaces the drift. Prod-specific noise (real bucket
 * names, generation/run IDs, wall-clock timestamps, download URLs) is not
 * asserted.
 *
 * Every storage observation in the directory must be either asserted
 * here or explicitly listed in NOT_APPLICABLE with a reason — the
 * completeness test at the bottom enforces that, so a new capture can't
 * silently go un-checked.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { createObservationGate } from '../../../../packages/conformance/src/observation-gate.ts';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getStorageSandbox,
  ref,
  uploadBytes,
  uploadString,
  getBytes,
  getBlob,
  getDownloadURL,
  deleteObject,
  getMetadata,
  updateMetadata,
  listAll,
} from '../../src/storage/index.js';
import { parseStorageUrl } from '../../src/storage/url.js';
import { registerOracleDeleteListAllRulesSuite } from './oracle-delete-listall-rules-cases.js';
import { registerOracleGetBytesUploadStringSuite } from './oracle-getbytes-uploadstring-cases.js';
import { registerOracleListAllSuite } from './oracle-listall-cases.js';
import { registerOracleMetadataSuite } from './oracle-metadata-cases.js';
import { registerOracleRefSuite } from './oracle-ref-cases.js';
import { registerOracleResumableMetadataSuite } from './oracle-resumable-metadata-cases.js';
import { registerOracleUploadBytesSuite } from './oracle-uploadbytes-cases.js';

// storage-* and client-storage-* observations live under the 'storage' surface subdirectory.
const OBS_DIR = join(import.meta.dir, '..', '..', '..', '..', 'packages', 'conformance', 'observations', 'storage');

/** Observations that cannot be replayed against the sandbox, with the reason. */
const NOT_APPLICABLE: Record<string, string> = {};

// Instrumented completeness gate: `load(name)` records which behavior fields are
// read so the completeness test can fail an observation that is only mentioned in
// a comment or loaded but never asserted. See
// `packages/conformance/src/observation-gate.ts` for the mechanism and its limits.
const obsGate = createObservationGate({
  dir: OBS_DIR,
  match: (f) => f.startsWith('storage-') || f.startsWith('client-storage-'),
  notApplicable: NOT_APPLICABLE,
});

function load(name: string): Record<string, unknown> {
  return obsGate.load(name);
}

function uniqueDbName(label: string): string {
  return `pyric-storage-oracle-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

const OPEN_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

function freshStorage(label: string, rules: string = OPEN_RULES) {
  const sandbox = initializeSandbox({});
  return getStorageSandbox(sandbox, { dbName: uniqueDbName(label), rules });
}

/** Run `fn`, return the thrown error, fail if nothing threw. */
async function caught(fn: () => Promise<unknown>): Promise<{ code?: unknown; message?: string }> {
  try {
    await fn();
  } catch (e) {
    return e as { code?: unknown; message?: string };
  }
  throw new Error('expected the operation to throw, but it resolved');
}

/** One `ref()` call recorded in `client-storage-ref-urls`. */
interface RefCase {
  input: string;
  parent?: string;
  threw: boolean;
  bucket?: string;
  fullPath?: string;
  name?: string;
  code?: string;
}

/** Replay one recorded `ref()` call and assert its path fields or its error code. */
function expectRefCase(storage: ReturnType<typeof freshStorage>, recorded: RefCase): void {
  const call = () => (recorded.parent === undefined ? ref(storage, recorded.input) : ref(ref(storage, recorded.parent), recorded.input));
  if (recorded.threw) {
    expect(call).toThrow(expect.objectContaining({ code: recorded.code }));
    return;
  }
  const made = call();
  expect({ fullPath: made.fullPath, name: made.name }).toEqual({ fullPath: recorded.fullPath!, name: recorded.name! });
}

const DENY_ALL = `
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}`;

describe('oracle conformance (storage)', () => {
  // ── errors ───────────────────────────────────────────────────────────

  it('storage#64: storage-delete-missing-throws rejects with storage/object-not-found after rules check', async () => {
    const obs = load('storage-delete-missing-throws.json');
    expect(obs.threw).toBe(true);
    expect(obs.code).toBe('storage/object-not-found');
    expect(obs.errorName).toBe('FirebaseError');
    expect(obs.isFirebaseError).toBe(true);
    expect((obs.message as string).length).toBeGreaterThan(0);

    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox, { dbName: uniqueDbName('delete-missing'), rules: OPEN_RULES });
    const countDeletes = (path: string): number =>
      sandbox
        .history()
        .filter((e) => e.kind === 'service_mutation' && e.service === 'storage' && e.op === 'object_delete' && e.path === path)
        .length;

    const missingRef = ref(storage, 'delete-missing/never-existed.bin');
    const missingErr = await caught(() => deleteObject(missingRef));
    expect(missingErr.code).toBe(obs.code as string);
    expect(countDeletes(missingRef.fullPath)).toBe(0);

    const ephemeralRef = ref(storage, 'delete-missing/once.bin');
    await uploadBytes(ephemeralRef, new Uint8Array([1, 2, 3]));
    await expect(deleteObject(ephemeralRef)).resolves.toBeUndefined();
    expect(countDeletes(ephemeralRef.fullPath)).toBe(1);

    const redeleteErr = await caught(() => deleteObject(ephemeralRef));
    expect(redeleteErr.code).toBe(obs.code as string);
    expect(countDeletes(ephemeralRef.fullPath)).toBe(1);

    const raceRef = ref(storage, 'delete-missing/race.bin');
    await uploadBytes(raceRef, new Uint8Array([4, 5, 6]));
    const settled = await Promise.allSettled([deleteObject(raceRef), deleteObject(raceRef)]);
    const fulfilledCount = settled.filter((r) => r.status === 'fulfilled').length;
    const rejectedCodes = settled
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason as { code?: unknown }).code);
    expect(fulfilledCount).toBe(1);
    expect(rejectedCodes).toEqual([obs.code]);
    expect(countDeletes(raceRef.fullPath)).toBe(1);

    const ownerMetadataRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow delete: if request.auth != null && resource.metadata.owner == request.auth.uid;
    }
  }
}`;
    const guarded = freshStorage('delete-missing-guarded', ownerMetadataRules);
    const deniedMissingErr = await caught(() => deleteObject(ref(guarded, 'delete-missing/secret.bin')));
    expect(deniedMissingErr.code).toBe('storage/unauthorized');
  });

  it('storage-delete-then-get-throws', async () => {
    const obs = load('storage-delete-then-get-throws.json');
    const storage = freshStorage('delete-then-get');
    const r = ref(storage, 'delete-then-get/soon-gone.bin');
    await uploadBytes(r, new Blob(['x']));
    await deleteObject(r);
    const e = await caught(() => getDownloadURL(r));
    expect(obs.getUrlThrew).toBe(true); // what prod did (the target)
    expect(e.code).toBe(obs.code as string);
  });

  it('storage#61: client-storage-getblob-root-ref throws synchronously on root reference', async () => {
    const obs = load('client-storage-getblob-root-ref.json');
    const browserRoot = obs.browserRootRef as {
      rootFullPath: string;
      rootName: string;
      threw: boolean;
      threwSynchronously: boolean;
      code: string;
      fetchCalls: number;
    };
    const nodeRoot = obs.nodeEntryRootRef as {
      threw: boolean;
      threwSynchronously: boolean;
      code: string | null;
    };
    expect(nodeRoot.threw).toBe(true);
    expect(nodeRoot.threwSynchronously).toBe(true);
    expect(nodeRoot.code).toBeNull();

    const storage = freshStorage('getblob-root-ref');
    const rootRef = ref(storage);
    expect(rootRef.fullPath).toBe(browserRoot.rootFullPath);
    expect(rootRef.name).toBe(browserRoot.rootName);

    let threwSynchronously = false;
    let code: string | null = null;
    try {
      getBlob(rootRef).catch(() => {});
    } catch (err) {
      threwSynchronously = true;
      code = (err as { code?: string }).code ?? null;
    }
    expect(threwSynchronously).toBe(browserRoot.threwSynchronously);
    expect(code).toBe(browserRoot.code);

    const missingErr = await caught(() => getBlob(ref(storage, 'items/missing.bin')));
    expect(missingErr.code).toBe('storage/object-not-found');
  });

  it('storage#67: storage-delete-then-getmetadata-throws removes stored metadata on deleteObject', async () => {
    const obs = load('storage-delete-then-getmetadata-throws.json');
    const beforeDelete = obs.beforeDelete as {
      size: number;
      contentType: string;
      customMetadata: Record<string, string>;
      hasGeneration: boolean;
      metageneration: string;
    };
    const afterDelete = obs.afterDeleteGetMetadata as {
      threw: boolean;
      code: string;
    };

    const storage = freshStorage('delete-then-getmetadata');
    const r = ref(storage, 'delete-then-getmetadata/ephemeral.bin');
    await uploadBytes(r, new Uint8Array([0x70, 0x79, 0x72, 0x69, 0x63]), {
      contentType: beforeDelete.contentType,
      customMetadata: beforeDelete.customMetadata,
    });

    const preMeta = await getMetadata(r);
    expect(preMeta.size).toBe(beforeDelete.size);
    expect(preMeta.contentType).toBe(beforeDelete.contentType);
    expect(preMeta.customMetadata).toEqual(beforeDelete.customMetadata);
    expect(preMeta.generation.length > 0).toBe(beforeDelete.hasGeneration);
    expect(preMeta.metageneration).toBe(beforeDelete.metageneration);

    await deleteObject(r);
    expect(obs.deleteCompleted).toBe(true);

    const err = await caught(() => getMetadata(r));
    expect(afterDelete.threw).toBe(true);
    expect(err.code).toBe(afterDelete.code);
  });

  it('storage-rules-denied-error-code', async () => {
    const obs = load('storage-rules-denied-error-code.json');
    const storage = freshStorage('rules-denied', DENY_ALL);
    const r = ref(storage, 'forbidden.bin');
    const e = await caught(() => uploadBytes(r, new Blob(['x'])));
    expect(e.code).toBe(obs.code as string);
  });

  it('storage-rules-denied-signed-out-error-code', async () => {
    // Prod capture: with no signed-in user, an upload under
    // `allow read, write: if request.auth != null` (the oracle namespace) and
    // one outside any grant both throw storage/unauthorized (HTTP 403), never
    // storage/unauthenticated; an anonymous user's upload under the namespace
    // succeeds, which shows the namespace rule was deployed. The sandbox
    // gives the same codes. Docs pin: DT-H1-11 in
    // packages/cli/test/docs-production-claims.test.ts.
    const obs = load('storage-rules-denied-signed-out-error-code.json');
    type Attempt = { threw: boolean; code: string | null };
    const signedOutNamespace = obs.signedOutNamespace as Attempt;
    const signedOutOutside = obs.signedOutOutside as Attempt;
    const anonymousNamespace = obs.anonymousNamespace as Attempt;
    expect(obs.signedOutCurrentUser).toBeNull();
    expect(obs.namespaceRuleDeployed).toBe(true);

    const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /pyric_oracle/{run}/{allPaths=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;
    const sandbox = initializeSandbox({});
    const signedOut = getStorageSandbox(sandbox, { dbName: uniqueDbName('signed-out'), rules });
    const inNamespace = await caught(() => uploadBytes(ref(signedOut, 'pyric_oracle/r/signed-out/forbidden.bin'), new Blob(['x'])));
    expect({ threw: true, code: inNamespace.code }).toEqual({ threw: signedOutNamespace.threw, code: signedOutNamespace.code });
    const outside = await caught(() => uploadBytes(ref(signedOut, 'pyric_oracle_denied_storage/r/signed-out.bin'), new Blob(['x'])));
    expect({ threw: true, code: outside.code }).toEqual({ threw: signedOutOutside.threw, code: signedOutOutside.code });

    const anonymous = getStorageSandbox(sandbox.withAuth({ uid: 'anon' }), { dbName: uniqueDbName('anonymous'), rules });
    await uploadBytes(ref(anonymous, 'pyric_oracle/r/anonymous/control.bin'), new Blob(['x']));
    expect(anonymousNamespace.threw).toBe(false);
  });

  it('storage-uploadstring-unknown-format', async () => {
    const obs = load('storage-uploadstring-unknown-format.json');
    expect(obs.unknownCode).toBe('storage/unknown');
    expect(obs.base64urlOk).toBe(true);
    expect(obs.base64urlCode).toBeNull();

    const storage = freshStorage('unknown-format');

    const eUnknown = await caught(() =>
      uploadString(ref(storage, 'a.bin'), 'hello', 'totally-bogus-format' as unknown as 'raw'),
    );
    expect(eUnknown.code).toBe(obs.unknownCode as string);

    const b64urlRef = ref(storage, 'b.bin');
    await uploadString(b64urlRef, 'aGVsbG8=', 'base64url');
    const readBack = new TextDecoder().decode(await getBytes(b64urlRef));
    expect(readBack).toBe('hello');
  });

  // ── round-trips ──────────────────────────────────────────────────────

  it('storage-upload-bytes-roundtrip', async () => {
    const obs = load('storage-upload-bytes-roundtrip.json');
    const storage = freshStorage('upload-bytes-roundtrip');
    const payload = new TextEncoder().encode('abcdef'); // bodyLen 6, matches the capture
    expect(payload.length).toBe(obs.payloadLen as number);

    const r = ref(storage, 'roundtrip/bytes.bin');
    const upload = await uploadBytes(r, payload);
    expect(upload.metadata.size).toBe(obs.bodyLen as number);

    const url = await getDownloadURL(r);
    const read = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const bytesMatch = read.length === payload.length && read.every((b, i) => b === payload[i]);
    expect(bytesMatch).toBe(obs.bytesMatch as boolean);
    expect(obs.urlIsHttps).toBe(true); // production URL shape
    expect(url.startsWith('data:')).toBe(true); // sandbox portable data: URI
  });

  it('storage-uploadstring-base64-roundtrip', async () => {
    const obs = load('storage-uploadstring-base64-roundtrip.json');
    const storage = freshStorage('uploadstring-base64');
    const r = ref(storage, 'roundtrip/hello.txt');
    await uploadString(r, 'aGVsbG8=', 'base64');
    const url = await getDownloadURL(r);
    const text = await (await fetch(url)).text();
    expect(text).toBe(obs.downloadText as string);
    expect(text === (obs.downloadText as string)).toBe(obs.textMatches as boolean);
  });

  it('storage-upload-then-getmetadata', async () => {
    const obs = load('storage-upload-then-getmetadata.json');
    const storage = freshStorage('upload-then-getmetadata');
    const r = ref(storage, 'upload-getmd/octet.bin');
    const payload = new Uint8Array(obs.metadataSize as number); // 128 bytes, matches the capture
    await uploadBytes(r, payload, { contentType: 'application/octet-stream' });

    const md = await getMetadata(r);
    expect(md.contentType).toBe(obs.metadataContentType as string);
    expect(md.contentType === (obs.metadataContentType as string)).toBe(
      obs.contentTypeMatches as boolean,
    );
    expect(md.size).toBe(obs.metadataSize as number);
    expect(md.size === (obs.metadataSize as number)).toBe(obs.sizeMatches as boolean);
    expect(md.fullPath).toBe(r.fullPath);

    const hasMd5Hash = typeof md.md5Hash === 'string' && md.md5Hash.length > 0;
    expect(hasMd5Hash).toBe(obs.hasMd5Hash as boolean);
  });

  it('storage-update-metadata-roundtrip', async () => {
    const obs = load('storage-update-metadata-roundtrip.json');
    const storage = freshStorage('update-metadata-roundtrip');
    const r = ref(storage, 'roundtrip/meta.bin');
    const upload = await uploadBytes(r, new Blob(['x']));
    expect(upload.metadata.metageneration).toBe(obs.metagenerationBefore as string);
    expect(upload.metadata.customMetadata ?? null).toBe(obs.beforeCustom as null);

    const patch = { conformance: 'storage-row-90', run: 'sandbox-run' };
    const updated = await updateMetadata(r, { customMetadata: patch });
    expect(updated.customMetadata).toEqual(patch);
    const customSurvived = updated.customMetadata?.conformance === patch.conformance;
    expect(customSurvived).toBe(obs.customSurvived as boolean);

    expect(updated.metageneration).toBe(obs.metagenerationAfter as string);
    const metagenerationBumped = updated.metageneration !== upload.metadata.metageneration;
    expect(metagenerationBumped).toBe(obs.metagenerationBumped as boolean);
  });

  // ── shapes ───────────────────────────────────────────────────────────

  it('storage-listall-shape', async () => {
    const obs = load('storage-listall-shape.json');
    const storage = freshStorage('listall-shape');
    await uploadBytes(ref(storage, 'listall/a.bin'), new Blob(['a']));
    await uploadBytes(ref(storage, 'listall/b.bin'), new Blob(['b']));
    await uploadBytes(ref(storage, 'listall/c.bin'), new Blob(['c']));
    await uploadBytes(ref(storage, 'listall/sub/d.bin'), new Blob(['d']));

    const result = await listAll(ref(storage, 'listall'));
    expect(result.items.length).toBe(obs.itemCount as number);
    expect(result.prefixes.length).toBe(obs.prefixCount as number);
    expect(result.items.length === 3).toBe(obs.threeDirectChildren as boolean);
    expect(result.prefixes.length === 1).toBe(obs.oneSubPrefix as boolean);
    expect(result.items.map((i) => i.name)).toEqual(['a.bin', 'b.bin', 'c.bin']);
    expect(result.prefixes.map((p) => p.name)).toEqual(['sub']);
  });

  // ── ref(storage, url) ────────────────────────────────────────────────
  // Each case in `client-storage-ref-urls` is one ref() call: its `input`
  // is replayed as given, against a sandbox handle in place of production's.

  it('storage#110: a gs:// URL gives the reference at its path', () => {
    const obs = load('client-storage-ref-urls.json');
    const storage = freshStorage('ref-url-gs');
    const plain = obs.plainPath as RefCase;
    expectRefCase(storage, obs.gsDefaultBucket as RefCase);
    expectRefCase(storage, obs.gsPathNotDecoded as RefCase);
    expectRefCase(storage, obs.gsBucketRoot as RefCase);
    expectRefCase(storage, obs.gsNoBucket as RefCase);
    // A gs:// URL on the default bucket is the same reference as its path.
    expect((obs.gsDefaultBucket as RefCase).bucket).toBe(plain.bucket as string);
    expect(ref(storage, (obs.gsDefaultBucket as RefCase).input).bucket).toBe(ref(storage, plain.input).bucket);
  });

  it('storage#111: a download URL gives the reference at its decoded path', () => {
    const obs = load('client-storage-ref-urls.json');
    const storage = freshStorage('ref-url-download');
    expectRefCase(storage, obs.firebaseDownloadUrl as RefCase);
    expectRefCase(storage, obs.firebaseDownloadUrlEncoded as RefCase);
    expectRefCase(storage, obs.cloudStorageUrl as RefCase);
    expectRefCase(storage, obs.firebaseUrlNoObject as RefCase);
  });

  it('storage#112: a URL on another host throws storage/invalid-url', () => {
    const obs = load('client-storage-ref-urls.json');
    expectRefCase(freshStorage('ref-url-other-host'), obs.otherHostUrl as RefCase);
  });

  it("storage#113: the Node host's download URL (KNOWN DIVERGENCE)", () => {
    // Production throws storage/invalid-url for the Node host's URL form, as
    // for any host it does not serve from. The sandbox issues that form from
    // getDownloadURL on the Node host, so its ref() reads the object path from
    // it, as production does from its own download URL.
    const obs = load('client-storage-ref-urls.json');
    const hosted = obs.pyricHostUrl as RefCase;
    expect(hosted.threw).toBe(true);
    expect(hosted.code).toBe('storage/invalid-url');

    const made = ref(freshStorage('ref-url-pyric-host'), hosted.input);
    const production = obs.firebaseDownloadUrl as RefCase;
    expect({ fullPath: made.fullPath, name: made.name }).toEqual({ fullPath: production.fullPath!, name: production.name! });
  });

  it("storage#114: the reference's bucket (KNOWN DIVERGENCE)", () => {
    // Production gives a reference on the URL's bucket, including another
    // bucket. The sandbox serves one bucket (storage#11), so the reference is
    // on it, at the URL's path.
    const obs = load('client-storage-ref-urls.json');
    const storage = freshStorage('ref-url-bucket');
    for (const recorded of [obs.gsOtherBucket as RefCase, obs.firebaseDownloadUrlOtherBucket as RefCase]) {
      expect(recorded.bucket).toBe('other-bucket');
      // The parser reads the URL's bucket as production does; ref() places
      // the reference on the sandbox's bucket.
      expect(parseStorageUrl(recorded.input).bucket).toBe(recorded.bucket!);
      const made = ref(storage, recorded.input);
      expect(made.bucket).toBe(ref(storage).bucket);
      expect(made.fullPath).toBe(recorded.fullPath!);
    }
  });

  it('storage#115: a data: URI (KNOWN DIVERGENCE)', () => {
    // Production reads a data: URI as an object path. The sandbox's
    // getDownloadURL returns a data: URI in process and on a SharedWorker
    // host, and no object exists at that literal path, so ref() throws
    // storage/invalid-url instead of naming one.
    const obs = load('client-storage-ref-urls.json');
    const dataUri = obs.dataUri as RefCase;
    expect(dataUri.threw).toBe(false);
    expect(dataUri.fullPath).toBe(dataUri.input);

    const storage = freshStorage('ref-url-data');
    expect(() => ref(storage, dataUri.input)).toThrow(expect.objectContaining({ code: 'storage/invalid-url' }));
  });

  it('storage#115: a reference to a data: download URL throws instead of naming no object', async () => {
    const storage = freshStorage('ref-url-data-delete');
    const object = ref(storage, 'media/take.wav');
    await uploadBytes(object, new Uint8Array([1, 2, 3]), { contentType: 'audio/wav' });
    const url = await getDownloadURL(object);
    expect(url.startsWith('data:audio/wav;base64,')).toBe(true);
    expect(() => ref(storage, url)).toThrow(expect.objectContaining({ code: 'storage/invalid-url' }));
    expect((await getMetadata(object)).size).toBe(3);
  });

  it('storage#116: ref(reference, url) throws storage/invalid-argument', () => {
    const obs = load('client-storage-ref-urls.json');
    expectRefCase(freshStorage('ref-url-child'), obs.childRefWithUrl as RefCase);
  });

  registerOracleDeleteListAllRulesSuite({ load, freshStorage });
  registerOracleGetBytesUploadStringSuite({ load, freshStorage });
  registerOracleListAllSuite({ load, freshStorage });
  registerOracleMetadataSuite({ load, freshStorage });
  registerOracleRefSuite({ load, freshStorage });
  registerOracleResumableMetadataSuite({ load, freshStorage });
  registerOracleUploadBytesSuite({ load, freshStorage });

  // ── completeness: every observation is asserted or explicitly N/A ─────

  it('every storage observation is covered (no silent gaps)', () => {
    const r = obsGate.report();
    expect(r.committed.length).toBeGreaterThanOrEqual(10);
    expect(r.loadedButUnused).toEqual([]); // a bare load() with no field read fails
    expect(r.uncovered).toEqual([]); // every capture is asserted or explicitly N/A
  });
});
