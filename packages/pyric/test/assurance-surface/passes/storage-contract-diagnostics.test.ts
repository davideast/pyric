import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getStorageSandbox, ref as storageRef, uploadBytes } from 'pyric/storage';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import { extractSdkUsage } from '../../../src/assurance-surface/code/usage-index.js';
import { storageContractPass } from '../../../src/assurance-surface/passes/storage-contract.js';

function renderDiagPath(diag: ReturnType<typeof storageContractPass>[number]): string {
  if (!diag.resource) return '';
  return diag.resource.segments
    .map((s) => {
      if (s.kind === 'lit') return s.text;
      return `{${s.name}}`;
    })
    .join('/');
}

describe('storageContractPass HTTP metadata and typed binary/Blob diagnostics', () => {
  it('flags static HTTP header mismatches (even alongside unresolved sibling headers) and emits heuristic diagnostics for unresolved HTTP headers', () => {
    const rules = `
      rules_version = '2';
      service firebase.storage {
        match /b/{bucket}/o {
          match /combo/{uid}/{file} {
            allow read, write: if request.auth != null
              && request.auth.uid == uid
              && request.resource.cacheControl == 'public, max-age=3600'
              && request.resource.contentLanguage == 'en';
          }
          match /single/{uid}/{file} {
            allow read, write: if request.auth != null
              && request.auth.uid == uid
              && request.resource.cacheControl == 'public, max-age=3600';
          }
        }
      }
    `;

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/http-headers.ts': `
          import { getAuth } from 'pyric/auth';
          import { getStorage, ref, updateMetadata, uploadBytes } from 'pyric/storage';

          export async function run(dynLang: string, dynCache: string) {
            const uid = getAuth().currentUser!.uid;
            const st = getStorage();
            // 1. Valid static headers -> 0 diagnostics
            await uploadBytes(ref(st, 'combo/' + uid + '/ok'), new Uint8Array([1]), {
              cacheControl: 'public, max-age=3600',
              contentLanguage: 'en',
            });
            // 2. Static cacheControl mismatch + unresolved sibling contentLanguage -> static-proof!
            await uploadBytes(ref(st, 'combo/' + uid + '/bad-sibling'), new Uint8Array([1]), {
              cacheControl: 'private, no-store',
              contentLanguage: dynLang,
            });
            // 3. Purely static cacheControl mismatch -> static-proof!
            await uploadBytes(ref(st, 'single/' + uid + '/bad-static'), new Uint8Array([1]), {
              cacheControl: 'private, no-store',
            });
            // 4. Omitted required cacheControl on uploadBytes -> static-proof!
            await uploadBytes(ref(st, 'single/' + uid + '/omitted'), new Uint8Array([1]));
            // 5. Omitted cacheControl on updateMetadata preserves existing resource.cacheControl -> 0 diagnostics!
            await updateMetadata(ref(st, 'single/' + uid + '/patch-ok'), {
              contentLanguage: 'en',
            });
            // 6. Unresolved cacheControl under constrained rule -> heuristic!
            await uploadBytes(ref(st, 'single/' + uid + '/dyn-cache'), new Uint8Array([1]), {
              cacheControl: dynCache,
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
        path: renderDiagPath(d),
      })),
    ).toEqual([
      {
        code: 'storage-http-metadata-mismatch',
        certainty: 'static-proof',
        path: 'combo/{uid}/bad-sibling',
      },
      {
        code: 'storage-http-metadata-mismatch',
        certainty: 'static-proof',
        path: 'single/{uid}/bad-static',
      },
      {
        code: 'storage-http-metadata-mismatch',
        certainty: 'static-proof',
        path: 'single/{uid}/omitted',
      },
      {
        code: 'storage-http-metadata-unverified',
        certainty: 'heuristic',
        path: 'single/{uid}/dyn-cache',
      },
    ]);
  });

  it('flags Uint8Array, ArrayBuffer, and untyped new File uploads as static-proof MIME mismatches while surfacing Blob uploads as heuristic', () => {
    const rules = `
      rules_version = '2';
      service firebase.storage {
        match /b/{bucket}/o {
          match /imgs/{uid}/{file} {
            allow read, write: if request.auth != null
              && request.auth.uid == uid
              && request.resource.contentType.matches('image/.*');
          }
        }
      }
    `;

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/binary-uploads.ts': `
          import { getAuth } from 'pyric/auth';
          import { getStorage, ref, uploadBytes } from 'pyric/storage';

          export async function run(u8: Uint8Array, ab: ArrayBuffer, b: Blob) {
            const uid = getAuth().currentUser!.uid;
            const st = getStorage();
            await uploadBytes(ref(st, 'imgs/' + uid + '/a'), u8);
            await uploadBytes(ref(st, 'imgs/' + uid + '/b'), ab);
            await uploadBytes(ref(st, 'imgs/' + uid + '/c'), b);
            await uploadBytes(ref(st, 'imgs/' + uid + '/d'), new File(['hi'], 'note.txt'));
          }
        `,
      },
    });

    const diagnostics = storageContractPass(usage, rules);
    expect(
      diagnostics
        .map((d) => ({
          code: d.code,
          certainty: d.certainty,
          path: renderDiagPath(d),
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    ).toEqual([
      {
        code: 'storage-content-type-mismatch',
        certainty: 'static-proof',
        path: 'imgs/{uid}/a',
      },
      {
        code: 'storage-content-type-mismatch',
        certainty: 'static-proof',
        path: 'imgs/{uid}/b',
      },
      {
        code: 'storage-content-type-unverified',
        certainty: 'heuristic',
        path: 'imgs/{uid}/c',
      },
      {
        code: 'storage-content-type-mismatch',
        certainty: 'static-proof',
        path: 'imgs/{uid}/d',
      },
    ]);
  });

  it('matches getStorageSandbox() defaults for omitted contentEncoding ("identity") and omitted upload contentDisposition ("inline; filename*=utf-8\'\'<file>")', async () => {
    const rules = `
      rules_version = '2';
      service firebase.storage {
        match /b/{bucket}/o {
          match /enc/{uid}/{name} {
            allow write: if request.auth != null
              && request.auth.uid == uid
              && request.resource.contentEncoding == 'identity';
          }
          match /disp/{uid}/{name} {
            allow write: if request.auth != null
              && request.auth.uid == uid
              && request.resource.contentDisposition.matches('inline.*');
          }
          match /pdfdisp/{uid}/{name} {
            allow write: if request.auth != null
              && request.auth.uid == uid
              && request.resource.contentDisposition.matches('inline.*\\\\.pdf');
          }
          match /nullenc/{uid}/{name} {
            allow write: if request.auth != null
              && request.auth.uid == uid
              && request.resource.contentEncoding == null;
          }
          match /nulldisp/{uid}/{name} {
            allow write: if request.auth != null
              && request.auth.uid == uid
              && request.resource.contentDisposition == null;
          }
          match /nullencdyn/{uid}/{name} {
            allow write: if request.auth != null
              && request.auth.uid == uid
              && request.resource.contentEncoding == null
              && request.resource.contentLanguage == 'en';
          }
        }
      }
    `;

    const sandbox = initializeSandbox();
    getAdminStorageSandbox(sandbox, { rules });
    const u1Storage = getStorageSandbox(sandbox.withAuth({ uid: 'u1', token: {} }));
    await uploadBytes(storageRef(u1Storage, 'enc/u1/a.bin'), new Uint8Array([1]));
    await uploadBytes(storageRef(u1Storage, 'disp/u1/doc.pdf'), new Uint8Array([1]), {
      contentType: 'application/pdf',
    });
    await uploadBytes(storageRef(u1Storage, 'pdfdisp/u1/report.pdf'), new Uint8Array([1]));
    await expect(
      uploadBytes(storageRef(u1Storage, 'pdfdisp/u1/notes.txt'), new Uint8Array([1])),
    ).rejects.toThrow();
    await expect(
      uploadBytes(storageRef(u1Storage, 'nullenc/u1/a.bin'), new Uint8Array([1])),
    ).rejects.toThrow();
    await expect(
      uploadBytes(storageRef(u1Storage, 'nulldisp/u1/a.bin'), new Uint8Array([1])),
    ).rejects.toThrow();
    await expect(
      uploadBytes(storageRef(u1Storage, 'nullencdyn/u1/a.bin'), new Uint8Array([1]), {
        contentLanguage: 'en',
      }),
    ).rejects.toThrow();

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/defaults.ts': `
          import { getAuth } from 'pyric/auth';
          import { getStorage, ref, uploadBytes } from 'pyric/storage';

          export async function run(dynName: string, dynLang: string) {
            const uid = getAuth().currentUser!.uid;
            const st = getStorage();
            await uploadBytes(ref(st, 'enc/' + uid + '/a.bin'), new Uint8Array([1]));
            await uploadBytes(ref(st, 'disp/' + uid + '/doc.pdf'), new Uint8Array([1]), { contentType: 'application/pdf' });
            await uploadBytes(ref(st, 'pdfdisp/' + uid + '/' + dynName), new Uint8Array([1]));
            await uploadBytes(ref(st, 'nullenc/' + uid + '/a.bin'), new Uint8Array([1]));
            await uploadBytes(ref(st, 'nulldisp/' + uid + '/a.bin'), new Uint8Array([1]));
            await uploadBytes(ref(st, 'nullencdyn/' + uid + '/a.bin'), new Uint8Array([1]), { contentLanguage: dynLang });
          }
        `,
      },
    });

    const diagnostics = storageContractPass(usage, rules);
    expect(
      diagnostics
        .map((d) => ({
          code: d.code,
          certainty: d.certainty,
          path: renderDiagPath(d),
        }))
        .sort((a, b) => `${a.path}:${a.code}`.localeCompare(`${b.path}:${b.code}`)),
    ).toEqual([
      {
        code: 'storage-http-metadata-mismatch',
        certainty: 'static-proof',
        path: 'nulldisp/{uid}/a.bin',
      },
      {
        code: 'storage-http-metadata-mismatch',
        certainty: 'static-proof',
        path: 'nullenc/{uid}/a.bin',
      },
      {
        code: 'storage-http-metadata-mismatch',
        certainty: 'static-proof',
        path: 'nullencdyn/{uid}/a.bin',
      },
      {
        code: 'storage-http-metadata-unverified',
        certainty: 'heuristic',
        path: 'pdfdisp/{uid}/{dynName}',
      },
    ]);
  });
});
