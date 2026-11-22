/**
 * Regression suite for Storage rules `resource.*` persisted object fields and
 * `{ uid }` default `request.auth.token` (#1342).
 *
 * Production evidence:
 *  - `oracle:rules-storage-h1-resource-unmodeled-fields` (row `storage-rules#205`)
 *    and `oracle:stdlib-realstorage-p2-native-object-fields` (`stored-exact`)
 *    record production binding `md5Hash`, `crc32c`, `etag`, `contentDisposition`,
 *    `contentEncoding`, `contentLanguage`, and `cacheControl` on `resource`.
 *  - `packages/conformance/src/capture/storage-live/recordings/capture-s-wire.json`
 *    records production GCS `md5Hash` (RFC 1321 base64) and `crc32c` (4-byte
 *    big-endian Castagnoli CRC32C in standard RFC 4648 base64):
 *      - 6 bytes `[1, 2, 3, 4, 5, 6]` -> md5 `'asHla8ePAxBZvnvoVFIsTA=='`, crc32c `'T037qw=='`
 *      - 9 bytes `'capture s'`        -> md5 `'dOK4QenFEl7s1sZQsM3Jkw=='`, crc32c `'tO8izw=='`
 *  - Wire captures redact production's opaque `etag` to `'<etag>'`; the sandbox
 *    stores a deterministic non-empty synthetic version tag on `StoredMetadata`
 *    that refreshes whenever `generation` or `metageneration` advances.
 *  - `oracle:rules-storage-h1-auth-token-default` (row `storage-rules#210`)
 *    records `{ uid }` auth defaulting `request.auth.token` to `{}`.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  encodeBytesToBase64,
  restoreSandboxSnapshot,
  type SandboxSnapshot,
} from 'pyric/sandbox/internal';
import {
  getBytes,
  getMetadata,
  getStorageSandbox,
  ref,
  updateMetadata,
  uploadBytes,
  uploadBytesResumable,
  uploadString,
} from '../../../src/storage/index.js';
import {
  computeStorageEtag,
  copyObject,
  getAdminStorageSandbox,
  getStorageService,
  patchObjectMetadata,
  seedStorageObject,
} from '../../../src/storage/internal.js';

const SIX_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6]);
const SIX_BYTES_MD5 = 'asHla8ePAxBZvnvoVFIsTA==';
const SIX_BYTES_CRC32C = 'T037qw==';

const NINE_TEXT = 'capture s';
const NINE_BYTES = new TextEncoder().encode(NINE_TEXT);
const NINE_BYTES_MD5 = 'dOK4QenFEl7s1sZQsM3Jkw==';
const NINE_BYTES_CRC32C = 'tO8izw==';

const EMPTY_MD5 = '1B2M2Y8AsgTpgAmY7PhCfg==';
const EMPTY_CRC32C = 'AAAAAA==';

function uniqueDb(label: string): string {
  return `pyric-1342-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

describe('Storage rules resource.* fields and { uid } request.auth.token (#1342)', () => {
  it('binds all seven resource fields after uploadBytes with content headers set and matches capture-s-wire digests', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDb('all-seven');
    const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/six.bin {
      allow get: if resource.md5Hash == '${SIX_BYTES_MD5}'
        && resource.crc32c == '${SIX_BYTES_CRC32C}'
        && resource.etag is string
        && resource.etag != ''
        && resource.cacheControl == 'public, max-age=120'
        && resource.contentDisposition == 'attachment; filename="six.bin"'
        && resource.contentEncoding == 'gzip'
        && resource.contentLanguage == 'en-US';
    }
    match /items/empty.bin {
      allow get: if resource.md5Hash == '${EMPTY_MD5}'
        && resource.crc32c == '${EMPTY_CRC32C}'
        && resource.etag is string
        && resource.etag != '';
    }
  }
}`;
    const admin = getAdminStorageSandbox(sandbox, { dbName, rules });
    const client = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), { dbName, rules });

    await uploadBytes(ref(admin, 'items/six.bin'), SIX_BYTES, {
      contentType: 'application/octet-stream',
      cacheControl: 'public, max-age=120',
      contentDisposition: 'attachment; filename="six.bin"',
      contentEncoding: 'gzip',
      contentLanguage: 'en-US',
    });
    await uploadBytes(ref(admin, 'items/empty.bin'), new Uint8Array(0));

    const readSix = new Uint8Array(await getBytes(ref(client, 'items/six.bin')));
    expect(Array.from(readSix)).toEqual(Array.from(SIX_BYTES));
    const readEmpty = new Uint8Array(await getBytes(ref(client, 'items/empty.bin')));
    expect(readEmpty.byteLength).toBe(0);

    // Client FullMetadata returns md5Hash as production firebase/storage does,
    // without leaking internal crc32c/etag properties onto FullMetadata.
    const fullMeta = await getMetadata(ref(client, 'items/six.bin'));
    expect(fullMeta.md5Hash).toBe(SIX_BYTES_MD5);
    expect('crc32c' in (fullMeta as unknown as Record<string, unknown>)).toBe(false);
    expect('etag' in (fullMeta as unknown as Record<string, unknown>)).toBe(false);
  });

  it('populates md5Hash, crc32c, and etag across uploadString, uploadBytesResumable, copyObject, and seedStorageObject', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDb('all-writers');
    const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /writers/{name} {
      allow create: if true;
      allow get: if resource.md5Hash == '${NINE_BYTES_MD5}'
        && resource.crc32c == '${NINE_BYTES_CRC32C}'
        && resource.etag is string
        && resource.etag != '';
    }
  }
}`;
    const admin = getAdminStorageSandbox(sandbox, { dbName, rules });
    const client = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), { dbName, rules });

    await uploadString(ref(client, 'writers/from-string.txt'), NINE_TEXT, 'raw');
    await uploadBytesResumable(ref(client, 'writers/from-resumable.txt'), NINE_BYTES);
    await copyObject(ref(admin, 'writers/from-string.txt'), ref(admin, 'writers/from-copy.txt'));
    await seedStorageObject(admin, 'writers/from-seed.txt', NINE_BYTES, { contentType: 'text/plain' });

    for (const file of ['from-string.txt', 'from-resumable.txt', 'from-copy.txt', 'from-seed.txt']) {
      const meta = await getMetadata(ref(client, `writers/${file}`));
      expect(meta.md5Hash).toBe(NINE_BYTES_MD5);
    }
  });

  it('preserves md5Hash and crc32c while refreshing etag across updateMetadata and patchObjectMetadata, and recomputes all three on overwrite', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDb('lifecycle');
    const openRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} { allow read, write: if true; }
  }
}`;
    const admin = getAdminStorageSandbox(sandbox, { dbName, rules: openRules });
    const client = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), { dbName, rules: openRules });
    const service = await getStorageService(admin);

    await uploadBytes(ref(client, 'doc.bin'), SIX_BYTES, { contentType: 'application/octet-stream' });
    const v1 = await service.backend.getMetadata('doc.bin');
    expect(v1?.md5Hash).toBe(SIX_BYTES_MD5);
    expect(v1?.crc32c).toBe(SIX_BYTES_CRC32C);
    expect(typeof v1?.etag).toBe('string');
    expect((v1?.etag ?? '').length).toBeGreaterThan(0);

    await updateMetadata(ref(client, 'doc.bin'), { cacheControl: 'no-store' });
    const v2 = await service.backend.getMetadata('doc.bin');
    expect(v2?.generation).toBe(v1?.generation);
    expect(v2?.metageneration).toBe('2');
    expect(v2?.md5Hash).toBe(SIX_BYTES_MD5);
    expect(v2?.crc32c).toBe(SIX_BYTES_CRC32C);
    expect(typeof v2?.etag).toBe('string');
    expect(v2?.etag).not.toBe(v1?.etag);

    await patchObjectMetadata(ref(admin, 'doc.bin'), { customMetadata: { stage: 'patched' } });
    const v3 = await service.backend.getMetadata('doc.bin');
    expect(v3?.metageneration).toBe('3');
    expect(v3?.md5Hash).toBe(SIX_BYTES_MD5);
    expect(v3?.crc32c).toBe(SIX_BYTES_CRC32C);
    expect(v3?.etag).not.toBe(v2?.etag);

    await uploadBytes(ref(client, 'doc.bin'), NINE_BYTES, { contentType: 'text/plain' });
    const v4 = await service.backend.getMetadata('doc.bin');
    expect(Number(v4?.generation)).toBeGreaterThan(Number(v3?.generation));
    expect(v4?.metageneration).toBe('1');
    expect(v4?.md5Hash).toBe(NINE_BYTES_MD5);
    expect(v4?.crc32c).toBe(NINE_BYTES_CRC32C);
    expect(v4?.etag).not.toBe(v3?.etag);
  });

  it('defaults request.auth.token to an empty map when auth supplies only { uid } (ST-H1-7)', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDb('uid-only-token');
    const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /tok/check.bin {
      allow create: if request.auth.uid == 'alice'
        && request.auth.token is map
        && request.auth.token.size() == 0
        && request.auth.token.get('admin', false) == false;
    }
  }
}`;
    const client = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), { dbName, rules });
    const events: Array<{ after?: unknown }> = [];
    const unsubscribe = sandbox.onEvent((event) => {
      if (event.kind === 'service_mutation' && event.service === 'storage') {
        events.push({ after: event.after });
      }
    });
    const uploaded = await uploadBytes(ref(client, 'tok/check.bin'), SIX_BYTES);
    unsubscribe();
    expect(uploaded.metadata.md5Hash).toBe(SIX_BYTES_MD5);
    const putAfter = events[0]?.after as { generation?: string; metageneration?: string; etag?: string } | undefined;
    expect(putAfter?.etag).toBe(
      computeStorageEtag(putAfter?.generation ?? '', putAfter?.metageneration ?? ''),
    );
  });

  it('backfills md5Hash, crc32c, and etag when restoring a legacy snapshot that omitted them', async () => {
    const sandbox = initializeSandbox({});
    const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /legacy/six.bin {
      allow get: if resource.md5Hash == '${SIX_BYTES_MD5}'
        && resource.crc32c == '${SIX_BYTES_CRC32C}'
        && resource.etag == '${computeStorageEtag('7', '2')}';
    }
  }
}`;
    const legacySnapshot: SandboxSnapshot = {
      version: 1,
      capturedAt: '2026-01-01T00:00:00.000Z',
      rules: {
        storage: { [DEFAULT_SNAPSHOT_RESOURCE]: rules },
      },
      auth: { users: [] },
      firestore: {},
      rtdb: {},
      storage: {
        [DEFAULT_SNAPSHOT_RESOURCE]: [
          {
            path: 'legacy/six.bin',
            contentBase64: encodeBytesToBase64(SIX_BYTES),
            size: SIX_BYTES.byteLength,
            contentType: 'application/octet-stream',
            generation: '7',
            metageneration: '2',
            timeCreated: '2026-01-01T00:00:00.000Z',
            updated: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    };
    const { refusals } = await restoreSandboxSnapshot(sandbox, legacySnapshot);
    expect(refusals).toEqual([]);
    const client = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }));
    const bytes = new Uint8Array(await getBytes(ref(client, 'legacy/six.bin')));
    expect(Array.from(bytes)).toEqual(Array.from(SIX_BYTES));
  });
});
