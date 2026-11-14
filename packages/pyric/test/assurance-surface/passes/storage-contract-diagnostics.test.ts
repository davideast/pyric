import { describe, expect, it } from 'bun:test';
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
});
