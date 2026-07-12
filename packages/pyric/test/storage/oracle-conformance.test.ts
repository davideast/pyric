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
 * Adaptation from the auth template: `getDownloadURL` is out of the v1
 * storage scope (see `src/storage/index.ts`'s scope comment), so
 * observations whose prod capture read content back via
 * `getDownloadURL` + `fetch` are replayed here with the sandbox's
 * in-process equivalent (`getBytes`/`getBlob`) — the fact under test
 * (uploaded bytes/text round-trip exactly) is the same; only the
 * transport differs, and that's called out per-test.
 *
 * Every storage observation in the directory must be either asserted
 * here or explicitly listed in NOT_APPLICABLE with a reason — the
 * completeness test at the bottom enforces that, so a new capture can't
 * silently go un-checked.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getStorageSandbox,
  ref,
  uploadBytes,
  uploadString,
  getBytes,
  deleteObject,
  getMetadata,
  updateMetadata,
  listAll,
} from '../../src/storage/index.js';

// storage-* observations live under the 'storage' surface subdirectory.
const OBS_DIR = join(import.meta.dir, '..', '..', '..', '..', 'packages', 'conformance', 'observations', 'storage');

/** Observations that cannot be replayed against the sandbox, with the reason. */
const NOT_APPLICABLE: Record<string, string> = {};

function load(name: string): Record<string, unknown> {
  const json = JSON.parse(readFileSync(join(OBS_DIR, name), 'utf8')) as {
    behavior: Record<string, unknown>;
  };
  return json.behavior;
}

function uniqueDbName(label: string): string {
  return `pyric-storage-oracle-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

function freshStorage(label: string, rules?: string) {
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

  it('storage-delete-missing-throws (KNOWN DIVERGENCE)', async () => {
    // Prod capture: deleteObject on a never-uploaded path throws
    // storage/object-not-found. The oracle's own description already
    // flags this: "Sandbox is no-op; this oracle locks prod's shape."
    // `deleteObject` in src/storage/download.ts is documented as
    // deliberately no-op on missing keys (persistence-layer no-op,
    // Slice 8 left as a follow-up to "reconsider whether to mirror the
    // strict throw"). Pin BOTH sides so neither drifts unnoticed: the
    // oracle's recorded prod value, and the sandbox's current behavior.
    const obs = load('storage-delete-missing-throws.json');
    expect(obs.threw).toBe(true); // what prod did (the target)
    expect(obs.code).toBe('storage/object-not-found');

    const storage = freshStorage('delete-missing');
    const r = ref(storage, 'delete-missing/never-existed.bin');
    // Sandbox today: resolves without throwing (no-op delete).
    await expect(deleteObject(r)).resolves.toBeUndefined();
  });

  it('storage-delete-then-get-throws', async () => {
    // Prod capture read the deleted object back via getDownloadURL,
    // which is out of the v1 scope (see file header). getMetadata is
    // the in-scope read op that surfaces the same
    // storage/object-not-found precondition on a missing path, so it
    // stands in for "read after delete" here.
    const obs = load('storage-delete-then-get-throws.json');
    const storage = freshStorage('delete-then-get');
    const r = ref(storage, 'delete-then-get/soon-gone.bin');
    await uploadBytes(r, new Blob(['x']));
    await deleteObject(r);
    const e = await caught(() => getMetadata(r));
    expect(obs.getUrlThrew).toBe(true); // what prod did (the target)
    expect(e.code).toBe(obs.code as string);
  });

  it('storage-rules-denied-error-code', async () => {
    const obs = load('storage-rules-denied-error-code.json');
    const storage = freshStorage('rules-denied', DENY_ALL);
    const r = ref(storage, 'forbidden.bin');
    const e = await caught(() => uploadBytes(r, new Blob(['x'])));
    expect(e.code).toBe(obs.code as string);
  });

  it('storage-uploadstring-unknown-format (KNOWN DIVERGENCE)', async () => {
    // Prod capture: a genuinely-unknown uploadString format string
    // throws storage/unknown; `base64url` (a format Firebase upstream
    // supports, just not exposed by this SDK's StringFormat type) is
    // accepted and uploads successfully (base64urlOk: true,
    // base64urlCode: null).
    //
    // The sandbox (src/storage/upload.ts `decodeString`) instead:
    //   - throws storage/invalid-format for ANY string outside
    //     'raw' | 'base64' | 'data_url' — including base64url, which
    //     it deliberately deny-lists (per that file's own comment,
    //     which asserts upstream throws "invalid-argument", itself not
    //     what the oracle recorded either: prod throws storage/unknown
    //     for a truly-unknown format, and doesn't error at all for
    //     base64url).
    // Two divergences from the same capture, pinned together: pin BOTH
    // sides so neither drifts unnoticed.
    const obs = load('storage-uploadstring-unknown-format.json');
    expect(obs.unknownCode).toBe('storage/unknown'); // prod: truly-unknown format
    expect(obs.base64urlOk).toBe(true); // prod: base64url is a VALID format
    expect(obs.base64urlCode).toBeNull();

    const storage = freshStorage('unknown-format');

    // Sandbox today: a truly-unknown format string throws invalid-format,
    // not storage/unknown.
    const eUnknown = await caught(() =>
      uploadString(ref(storage, 'a.bin'), 'hello', 'totally-bogus-format' as unknown as 'raw'),
    );
    expect(eUnknown.code).toBe('storage/invalid-format');

    // Sandbox today: base64url is deny-listed and throws invalid-format
    // instead of succeeding like prod does.
    const eBase64url = await caught(() =>
      uploadString(ref(storage, 'b.bin'), 'aGVsbG8=', 'base64url' as unknown as 'raw'),
    );
    expect(eBase64url.code).toBe('storage/invalid-format');
  });

  // ── round-trips ──────────────────────────────────────────────────────

  it('storage-upload-bytes-roundtrip', async () => {
    // Prod capture verified byte-for-byte equality via
    // getDownloadURL + fetch; getDownloadURL is out of the v1 scope
    // (see file header), so `getBytes` — the in-process read of the
    // same uploaded bytes — stands in for the fetch leg here.
    const obs = load('storage-upload-bytes-roundtrip.json');
    const storage = freshStorage('upload-bytes-roundtrip');
    const payload = new TextEncoder().encode('abcdef'); // bodyLen 6, matches the capture
    expect(payload.length).toBe(obs.payloadLen as number);

    const r = ref(storage, 'roundtrip/bytes.bin');
    const upload = await uploadBytes(r, payload);
    expect(upload.metadata.size).toBe(obs.bodyLen as number);

    const read = new Uint8Array(await getBytes(r));
    const bytesMatch = read.length === payload.length && read.every((b, i) => b === payload[i]);
    expect(bytesMatch).toBe(obs.bytesMatch as boolean);
  });

  it('storage-uploadstring-base64-roundtrip', async () => {
    // Prod capture decoded the fetched download back to text; here
    // `getBytes` + TextDecoder stands in for the fetch leg (see the
    // roundtrip test above for the same adaptation).
    const obs = load('storage-uploadstring-base64-roundtrip.json');
    const storage = freshStorage('uploadstring-base64');
    const r = ref(storage, 'roundtrip/hello.txt');
    await uploadString(r, 'aGVsbG8=', 'base64');
    const text = new TextDecoder().decode(await getBytes(r));
    expect(text).toBe(obs.downloadText as string);
    expect(text === (obs.downloadText as string)).toBe(obs.textMatches as boolean);
  });

  it('storage-upload-then-getmetadata (KNOWN DIVERGENCE: md5Hash)', async () => {
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

    // Prod always returns an md5Hash (hasMd5Hash: true in the capture).
    // The sandbox's `buildStoredMetadata` (src/storage/upload.ts) never
    // populates `md5Hash` at all — a gap the oracle surfaces, not a
    // silently-passing assertion.
    expect(obs.hasMd5Hash).toBe(true); // prod: always present
    expect(md.md5Hash).toBeUndefined(); // sandbox today: never set
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

  // ── completeness: every observation is asserted or explicitly N/A ─────

  it('every storage observation is covered (no silent gaps)', () => {
    const all = readdirSync(OBS_DIR).filter((f) => f.startsWith('storage-') && f.endsWith('.json'));
    expect(all.length).toBeGreaterThanOrEqual(9);
    const source = readFileSync(import.meta.path, 'utf8');
    const uncovered = all.filter(
      (f) => !source.includes(f.replace('.json', '')) && !(f in NOT_APPLICABLE),
    );
    expect(uncovered).toEqual([]);
  });
});
