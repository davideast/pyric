import { describe, expect, it } from 'bun:test';
import { extractSdkUsage } from '../../../src/assurance-surface/code/usage-index.js';
import { storageContractPass } from '../../../src/assurance-surface/passes/storage-contract.js';

describe('storageContractPass', () => {
  it('flags client operations and standalone refs targeting buckets absent from configuredBuckets while skipping Admin SDK buckets', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/client-storage.ts': `
          import { getStorage, ref, uploadBytes } from 'pyric/storage';
          import { getStorage as getAdminStorage } from 'firebase-admin/storage';
          declare const app: unknown;

          const primary = getStorage(app, 'gs://primary-assets');
          const unconfigured = getStorage(app, 'gs://rogue-bucket');
          export const orphanUrlRef = ref(primary, 'gs://shadow-bucket/exports/1.json');

          export async function saveFiles(bytes: Uint8Array) {
            await uploadBytes(ref(primary, 'public/ok.bin'), bytes);
            await uploadBytes(ref(unconfigured, 'public/fail.bin'), bytes);
            await getAdminStorage(app).bucket('gs://internal-admin-backups').file('dump.sql').save('SELECT 1;');
          }
        `,
      },
    });

    const diagnostics = storageContractPass(usage, {
      configuredBuckets: ['gs://primary-assets', 'secondary-assets'],
    });

    expect(diagnostics.map((d) => ({ code: d.code, resourceId: d.resourceId, certainty: d.certainty }))).toEqual([
      {
        code: 'storage-unconfigured-bucket',
        resourceId: 'rogue-bucket',
        certainty: 'static-proof',
      },
      {
        code: 'storage-unconfigured-bucket',
        resourceId: 'shadow-bucket',
        certainty: 'static-proof',
      },
    ]);
    expect(diagnostics[0]!.remediation).toContain('primary-assets');
  });

  it('enforces full-string CEL contentType.matches(...), sibling allow OR semantics, partial path certainty, and malformed regex safety', () => {
    const rules = `
      rules_version = '2';
      service firebase.storage {
        match /b/{bucket}/o {
          match /avatars/{uid}/{file} {
            allow write: if request.auth.uid == uid
              && request.resource.contentType.matches('image/.*');
          }
          match /docs/{orgId}/{file} {
            allow create: if request.resource.contentType.matches('application/pdf');
            allow create: if request.resource.contentType.matches('text/plain');
          }
          match /broken-regex/{file} {
            allow write: if request.resource.contentType.matches('[unterminated');
          }
        }
      }
    `;

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/uploads.ts': `
          import { getStorage, ref, uploadBytes, uploadBytesResumable, uploadString, StringFormat } from 'pyric/storage';
          import { getAdminStorage } from 'pyric-admin/storage';
          declare const dynamicBucketUrl: string;

          const storage = getStorage();
          const partialStorage = getStorage(undefined, dynamicBucketUrl);
          const admin = getAdminStorage();

          export async function run(uid: string) {
            // Valid MIME matches
            await uploadBytes(ref(storage, 'avatars/' + uid + '/ok.png'), new Uint8Array(8), {
              contentType: 'image/png',
            });
            // Sibling allow clause #2 accepts text/plain
            await uploadBytesResumable(ref(storage, 'docs/acme/readme.txt'), new Uint8Array(8), {
              contentType: 'text/plain',
            });
            // CEL .matches('image/.*') is full-string anchored: 'text/plain; image/png' MUST fail!
            await uploadBytes(ref(storage, 'avatars/' + uid + '/spoof.bin'), new Uint8Array(8), {
              contentType: 'text/plain; image/png',
            });
            // data_url MIME extraction ('text/html') fails both application/pdf and text/plain
            await uploadString(
              ref(storage, 'docs/acme/page.html'),
              'data:text/html;base64,PGgxPkhiPC9oMT4=',
              StringFormat.DATA_URL,
            );
            // Partial site (non-literal bucket) with mismatched MIME emits certainty: 'heuristic'
            await uploadBytes(ref(partialStorage, 'avatars/' + uid + '/bad.zip'), new Uint8Array(8), {
              contentType: 'application/zip',
            });
            // Malformed rule regex fails open without throwing or false-positiving
            await uploadBytes(ref(storage, 'broken-regex/file.bin'), new Uint8Array(8), {
              contentType: 'application/octet-stream',
            });
            // Admin SDK upload bypasses client Storage rules completely
            await admin.bucket().file('avatars/' + uid + '/export.csv').save('a,b', {
              contentType: 'text/csv',
            });
          }
        `,
      },
    });

    expect(usage.operations.find((op) => op.path.endsWith('/bad.zip'))?.resolution).toBe('partial');

    const diagnostics = storageContractPass(usage, rules);
    expect(
      diagnostics.map((d) => ({
        code: d.code,
        certainty: d.certainty,
        path: d.resource ? d.resource.segments.map((s) => (s.kind === 'lit' ? s.text : `{${s.name}}`)).join('/') : '',
      })),
    ).toEqual([
      {
        code: 'storage-content-type-mismatch',
        certainty: 'static-proof',
        path: 'avatars/{uid}/spoof.bin',
      },
      {
        code: 'storage-content-type-mismatch',
        certainty: 'static-proof',
        path: 'docs/acme/page.html',
      },
      {
        code: 'storage-content-type-mismatch',
        certainty: 'heuristic',
        path: 'avatars/{uid}/bad.zip',
      },
    ]);
  });

  it('flags payload size exceeding inclusive maxSizeBytes while honoring boundary equality and sibling allow clauses', () => {
    const rules = `
      rules_version = '2';
      service firebase.storage {
        match /b/{bucket}/o {
          match /thumbs/{uid}/{file} {
            allow write: if request.auth.uid == uid && request.resource.size < 100;
          }
          match /tiered/{file} {
            allow create: if request.resource.size <= 64;
            allow create: if request.resource.size <= 256;
          }
        }
      }
    `;

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/sizes.ts': `
          import { getStorage, ref, uploadBytes, uploadString } from 'pyric/storage';
          const storage = getStorage();

          export async function uploadSizes(uid: string, dynamicBytes: Uint8Array) {
            await uploadBytes(ref(storage, 'thumbs/' + uid + '/exact.bin'), new Uint8Array(99));
            await uploadBytes(ref(storage, 'thumbs/' + uid + '/too-big.bin'), new Uint8Array(100));
            await uploadBytes(ref(storage, 'tiered/mid.bin'), new Uint8Array(128));
            await uploadString(ref(storage, 'tiered/huge.txt'), '${'x'.repeat(300)}');
            await uploadBytes(ref(storage, 'thumbs/' + uid + '/unknown.bin'), dynamicBytes);
          }
        `,
      },
    });

    const diagnostics = storageContractPass(usage, rules);
    expect(
      diagnostics.map((d) => ({
        code: d.code,
        certainty: d.certainty,
        witness: d.witness,
      })),
    ).toEqual([
      {
        code: 'storage-max-size-exceeded',
        certainty: 'static-proof',
        witness: [{ sizeBytes: 100, maxSizeBytes: 99 }],
      },
      {
        code: 'storage-max-size-exceeded',
        certainty: 'static-proof',
        witness: [{ sizeBytes: 300, maxSizeBytes: 256 }],
      },
    ]);
  });

  it('flags missing required customMetadata keys across omitted, closed literal, and spread metadata without false-positiving on untraced metadata or missing process', () => {
    const rules = `
      rules_version = '2';
      service firebase.storage {
        match /b/{bucket}/o {
          match /records/{orgId}/{file} {
            allow create: if request.auth != null
              && request.resource.metadata.orgId != null
              && request.resource.metadata.owner == request.auth.uid;
          }
        }
      }
    `;

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/metadata.ts': `
          import { getStorage, ref, uploadBytes, uploadString, type UploadMetadata } from 'pyric/storage';
          import { getAuth } from 'pyric/auth';
          import { getAdminStorage } from 'pyric-admin/storage';

          const storage = getStorage();
          const admin = getAdminStorage();

          export async function run(
            orgId: string,
            dynamicBlob: Blob,
            extraCustom: Record<string, string>,
            untracedMeta: UploadMetadata,
          ) {
            const uid = getAuth().currentUser!.uid;
            // 1. Satisfied customMetadata -> 0 diagnostics
            await uploadBytes(ref(storage, 'records/' + orgId + '/ok.bin'), dynamicBlob, {
              customMetadata: { orgId, owner: uid },
            });
            // 2. Omitted metadata arg on uploadBytes with dynamicBlob -> static-proof!
            await uploadBytes(ref(storage, 'records/' + orgId + '/omitted.bin'), dynamicBlob);
            // 3. Closed metadata literal without customMetadata -> static-proof!
            await uploadString(ref(storage, 'records/' + orgId + '/no-custom.txt'), 'hi', 'raw', {
              contentType: 'text/plain',
            });
            // 4. Closed customMetadata missing 'owner' -> static-proof!
            await uploadBytes(ref(storage, 'records/' + orgId + '/partial-keys.bin'), dynamicBlob, {
              customMetadata: { orgId },
            });
            // 5. Spread customMetadata missing 'owner' -> heuristic!
            await uploadBytes(ref(storage, 'records/' + orgId + '/spread.bin'), dynamicBlob, {
              customMetadata: { ...extraCustom, orgId },
            });
            // 6. Untraced metadata variable -> 0 diagnostics (no false positive!)
            await uploadBytes(ref(storage, 'records/' + orgId + '/untraced.bin'), dynamicBlob, untracedMeta);
            // 7. Admin SDK save -> 0 diagnostics!
            await admin.bucket().file('records/' + orgId + '/admin.txt').save('ok');
          }
        `,
      },
    });

    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');
    Object.defineProperty(globalThis, 'process', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    let diagnostics: ReturnType<typeof storageContractPass>;
    try {
      diagnostics = storageContractPass(usage, { storageRules: rules });
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, 'process', descriptor);
      }
    }

    expect(
      diagnostics.map((d) => ({
        code: d.code,
        certainty: d.certainty,
        witness: d.witness,
      })),
    ).toEqual([
      {
        code: 'storage-missing-custom-metadata',
        certainty: 'static-proof',
        witness: [{ missingKeys: ['orgId', 'owner'] }],
      },
      {
        code: 'storage-missing-custom-metadata',
        certainty: 'static-proof',
        witness: [{ missingKeys: ['orgId', 'owner'] }],
      },
      {
        code: 'storage-missing-custom-metadata',
        certainty: 'static-proof',
        witness: [{ missingKeys: ['owner'] }],
      },
      {
        code: 'storage-missing-custom-metadata',
        certainty: 'heuristic',
        witness: [{ missingKeys: ['owner'] }],
      },
    ]);
  });

  it('evaluates sibling allow rules jointly per rule, checks updateMetadata with applyMetadataPatch semantics, preserves explicit empty contentType, and honors wildcardBucket alongside concrete buckets', () => {
    const rules = `
      rules_version = '2';
      service firebase.storage {
        match /b/{bucket}/o {
          match /split/{file} {
            allow create: if request.resource.contentType.matches('image/png')
              && request.resource.size <= 100;
            allow create: if request.resource.contentType.matches('application/pdf')
              && request.resource.size <= 10000;
          }
          match /managed/{uid}/{file} {
            allow create, update: if request.auth.uid == uid
              && request.resource.contentType.matches('image/.*')
              && request.resource.metadata.owner == request.auth.uid;
          }
        }
        match /b/media-prod/o {
          match /managed/{uid}/{file} {
            allow create: if request.auth.uid == uid
              && request.resource.contentType.matches('video/.*');
          }
        }
      }
    `;

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/joint.ts': `
          import { getStorage, ref, uploadBytes, updateMetadata } from 'pyric/storage';
          import { getAuth } from 'pyric/auth';
          declare const app: unknown;

          const appBucket = getStorage(app, 'gs://tenant-assets');
          const mediaBucket = getStorage(app, 'gs://media-prod');

          export async function run() {
            const uid = getAuth().currentUser!.uid;
            // 1. Joint pass: 50-byte image/png satisfies sibling #1 on wildcard bucket -> 0 diagnostics
            await uploadBytes(ref(appBucket, 'split/ok.png'), new Uint8Array(50), {
              contentType: 'image/png',
            });
            // 2. Split-rule trap: 500-byte image/png matches MIME of #1 and size of #2, but NEITHER rule jointly!
            await uploadBytes(ref(appBucket, 'split/trap.png'), new Uint8Array(500), {
              contentType: 'image/png',
            });
            // 3. Explicit { contentType: '' } fails image/.* (whereas Blob { type: '' } is unset)
            await uploadBytes(ref(appBucket, 'managed/' + uid + '/empty-ct.bin'), new Uint8Array(8), {
              contentType: '',
              customMetadata: { owner: uid },
            });
            await uploadBytes(
              ref(appBucket, 'managed/' + uid + '/blob-empty-type.bin'),
              new Blob(['abc'], { type: '' }),
              { customMetadata: { owner: uid } },
            );
            // 4. updateMetadata: mismatched contentType caught; omitted customMetadata preserved (not flagged!)
            await updateMetadata(ref(appBucket, 'managed/' + uid + '/bad-ct.png'), {
              contentType: 'text/plain',
            });
            await updateMetadata(ref(appBucket, 'managed/' + uid + '/good-ct.png'), {
              contentType: 'image/webp',
            });
            // 5. updateMetadata with explicit { customMetadata: {} } replaces metadata -> missing 'owner' caught!
            await updateMetadata(ref(appBucket, 'managed/' + uid + '/wiped-meta.png'), {
              contentType: 'image/png',
              customMetadata: {},
            });
            // 6. Concrete bucket rule OR-combines with wildcard bucket rule on media-prod
            await uploadBytes(ref(mediaBucket, 'managed/' + uid + '/ok-wildcard.png'), new Uint8Array(8), {
              contentType: 'image/png',
              customMetadata: { owner: uid },
            });
            await uploadBytes(ref(mediaBucket, 'managed/' + uid + '/ok-concrete.mp4'), new Uint8Array(8), {
              contentType: 'video/mp4',
            });
            await uploadBytes(ref(mediaBucket, 'managed/' + uid + '/clip.txt'), new Uint8Array(8), {
              contentType: 'text/plain',
            });
          }
        `,
      },
    });

    const diagnostics = storageContractPass(usage, rules);
    expect(
      diagnostics.map((d) => ({
        code: d.code,
        resourceId: d.resourceId,
        path: d.resource
          ? d.resource.segments.map((s) => (s.kind === 'lit' ? s.text : `{${s.name}}`)).join('/')
          : '',
      })),
    ).toEqual([
      {
        code: 'storage-content-type-mismatch',
        resourceId: 'media-prod',
        path: 'managed/{uid}/clip.txt',
      },
      {
        code: 'storage-content-type-mismatch',
        resourceId: 'tenant-assets',
        path: 'managed/{uid}/empty-ct.bin',
      },
      {
        code: 'storage-content-type-mismatch',
        resourceId: 'tenant-assets',
        path: 'managed/{uid}/bad-ct.png',
      },
      {
        code: 'storage-max-size-exceeded',
        resourceId: 'tenant-assets',
        path: 'split/trap.png',
      },
      {
        code: 'storage-missing-custom-metadata',
        resourceId: 'tenant-assets',
        path: 'managed/{uid}/wiped-meta.png',
      },
    ]);
  });

  it('evaluates RE2 POSIX character classes, \\A...\\z anchors, inline (?i) flags, and single-rule || branches identically to split allow statements', () => {
    const rules = `
      rules_version = '2';
      service firebase.storage {
        match /b/{bucket}/o {
          match /posix/{file} {
            allow create: if request.resource.contentType.matches('[[:alpha:]]+/[[:alpha:]]+');
          }
          match /anchored/{file} {
            allow create: if request.resource.contentType.matches('\\\\Aimage/png\\\\z');
          }
          match /inline-flag/{file} {
            allow create: if request.resource.contentType.matches('(?i)image/(png|jpeg)');
          }
          match /disjunctive/{file} {
            allow write: if request.auth != null && (
              (request.resource.contentType.matches('image/.*')
                && request.resource.size < 1000
                && 'orgId' in request.resource.metadata)
              || (request.resource.contentType.matches('video/.*')
                && request.resource.size < 50000)
            );
          }
        }
      }
    `;

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/re2-and-or.ts': `
          import { getStorage, ref, uploadBytes } from 'pyric/storage';
          const st = getStorage();

          export async function run() {
            await uploadBytes(ref(st, 'posix/ok.png'), new Uint8Array(8), { contentType: 'image/png' });
            await uploadBytes(ref(st, 'anchored/ok.png'), new Uint8Array(8), { contentType: 'image/png' });
            await uploadBytes(ref(st, 'inline-flag/upper.png'), new Uint8Array(8), { contentType: 'IMAGE/PNG' });
            await uploadBytes(ref(st, 'inline-flag/bad.pdf'), new Uint8Array(8), { contentType: 'application/pdf' });
            await uploadBytes(ref(st, 'disjunctive/oversized.png'), new Uint8Array(10000), {
              contentType: 'image/png',
              customMetadata: {},
            });
          }
        `,
      },
    });

    const diagnostics = storageContractPass(usage, rules);
    expect(
      diagnostics.map((d) => ({
        code: d.code,
        certainty: d.certainty,
        path: d.resource
          ? d.resource.segments.map((s) => (s.kind === 'lit' ? s.text : `{${s.name}}`)).join('/')
          : '',
      })),
    ).toEqual([
      {
        code: 'storage-content-type-mismatch',
        certainty: 'static-proof',
        path: 'inline-flag/bad.pdf',
      },
      {
        code: 'storage-max-size-exceeded',
        certainty: 'static-proof',
        path: 'disjunctive/oversized.png',
      },
      {
        code: 'storage-missing-custom-metadata',
        certainty: 'static-proof',
        path: 'disjunctive/oversized.png',
      },
    ]);
  });

  it('enforces conjoined contentType.matches(...) across >16 collapsed DNF arms without PCRE lookahead fail-open and enforces lower/exact request.resource.size bounds', () => {
    const manyOrBranches = Array.from(
      { length: 18 },
      (_, i) =>
        `(request.resource.metadata.tag${i} == 'v' && request.resource.contentType.matches('image/.*') && request.resource.contentType.matches('.*png'))`,
    ).join(' || ');
    const rules = `
      rules_version = '2';
      service firebase.storage {
        match /b/{bucket}/o {
          match /collapsed/{itemId} {
            allow write: if request.auth != null && (${manyOrBranches});
          }
          match /bounded/{itemId} {
            allow write: if request.auth != null
              && request.resource.size >= 100
              && request.resource.size <= 1000;
          }
          match /strict-lower/{itemId} {
            allow write: if request.auth != null
              && 64 == request.resource.size;
          }
        }
      }
    `;

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/bounds.ts': `
          import { getStorage, ref, uploadBytes, uploadString } from 'pyric/storage';
          const st = getStorage();

          export async function run() {
            await uploadString(ref(st, 'collapsed/i1'), 'hello', 'raw', {
              contentType: 'application/pdf',
              customMetadata: { tag: 'v0' },
            });
            await uploadString(ref(st, 'collapsed/i2'), 'hello', 'raw', {
              contentType: 'image/png',
              customMetadata: { tag: 'v0' },
            });
            await uploadString(ref(st, 'bounded/tiny'), 'hello');
            await uploadBytes(ref(st, 'bounded/ok'), new Uint8Array(100));
            await uploadBytes(ref(st, 'strict-lower/under'), new Uint8Array(63));
            await uploadBytes(ref(st, 'strict-lower/exact'), new Uint8Array(64));
            await uploadBytes(ref(st, 'strict-lower/over'), new Uint8Array(65));
          }
        `,
      },
    });

    const diagnostics = storageContractPass(usage, rules);
    expect(
      diagnostics.map((d) => ({
        code: d.code,
        certainty: d.certainty,
        path: d.resource
          ? d.resource.segments.map((s) => (s.kind === 'lit' ? s.text : `{${s.name}}`)).join('/')
          : '',
      })),
    ).toEqual([
      {
        code: 'storage-content-type-mismatch',
        certainty: 'static-proof',
        path: 'collapsed/i1',
      },
      {
        code: 'storage-max-size-exceeded',
        certainty: 'static-proof',
        path: 'strict-lower/over',
      },
      {
        code: 'storage-min-size-not-met',
        certainty: 'static-proof',
        path: 'bounded/tiny',
      },
      {
        code: 'storage-min-size-not-met',
        certainty: 'static-proof',
        path: 'strict-lower/under',
      },
    ]);
  });
});
