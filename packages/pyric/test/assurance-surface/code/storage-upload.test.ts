import { describe, expect, test } from 'bun:test';
import { extractSdkUsage } from '../../../src/assurance-surface/code/usage-index.js';

describe('storageUpload static metadata & byte-size extraction', () => {
  test('extracts contentType, UTF-8/base64/base64url/data_url string byte lengths, and typed-array/Blob sizes without Buffer', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');
    delete (globalThis as Record<string, unknown>).process;
    try {
      const usage = extractSdkUsage({
        root: 'app',
        files: {
          'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
          'src/uploads.ts': `
            import {
              getStorage,
              ref,
              uploadBytes,
              uploadBytesResumable,
              uploadString,
              updateMetadata,
              StringFormat,
            } from 'pyric/storage';
            import { getAuth } from 'pyric/auth';

            const storage = getStorage();

            export async function runUploads(orgId: string) {
              const user = getAuth().currentUser!;
              const fixedBuf = new Uint8Array(4096);
              await uploadBytes(ref(storage, 'files/' + user.uid + '/fixed.bin'), fixedBuf, {
                contentType: 'application/octet-stream',
                customMetadata: {
                  owner: user.uid,
                  orgId,
                  visibility: 'private',
                },
              });

              await uploadBytesResumable(
                ref(storage, 'files/' + user.uid + '/inline-arr.bin'),
                new Uint8Array([10, 20, 30, 40, 50]),
                { contentType: 'image/png' },
              );

              await uploadBytes(
                ref(storage, 'files/' + user.uid + '/encoded.txt'),
                new TextEncoder().encode('hello 🚀'),
              );

              await uploadBytes(
                ref(storage, 'files/' + user.uid + '/blob.txt'),
                new Blob(['abc', new Uint8Array(4)], { type: 'text/plain' }),
              );

              await uploadString(ref(storage, 'files/' + user.uid + '/raw.txt'), 'café');
              await uploadString(
                ref(storage, 'files/' + user.uid + '/b64.bin'),
                'aGVsbG8=',
                StringFormat.BASE64,
                { contentType: 'text/plain' },
              );
              await uploadString(
                ref(storage, 'files/' + user.uid + '/b64url.bin'),
                'aGVsbG8',
                'base64url',
              );
              await uploadString(
                ref(storage, 'files/' + user.uid + '/inline.svg'),
                'data:image/svg+xml;base64,PHN2Zy8+',
                StringFormat.DATA_URL,
              );

              await updateMetadata(ref(storage, 'files/' + user.uid + '/fixed.bin'), {
                customMetadata: {
                  ['__proto__']: 'safe',
                  owner: user.uid,
                },
              });
            }
          `,
        },
      });

      const byPath = new Map(usage.operations.map((op) => [`${op.op}:${op.path}`, op]));

      const fixed = byPath.get('uploadBytes:files/{uid}/fixed.bin')!;
      expect(fixed.storageUpload).toEqual({
        contentType: 'application/octet-stream',
        sizeBytes: 4096,
        customMetadataKeys: ['orgId', 'owner', 'visibility'],
        customMetadata: {
          orgId: { name: 'orgId', kind: 'unknown' },
          owner: {
            name: 'owner',
            kind: 'string',
            auth: [{ source: 'auth.uid', certainty: 'exact' }],
          },
          visibility: { name: 'visibility', kind: 'string', literal: 'private' },
        },
      });

      const inlineArr = byPath.get('uploadBytesResumable:files/{uid}/inline-arr.bin')!;
      expect(inlineArr.storageUpload).toEqual({
        contentType: 'image/png',
        sizeBytes: 5,
      });

      const encoded = byPath.get('uploadBytes:files/{uid}/encoded.txt')!;
      expect(encoded.storageUpload).toEqual({
        sizeBytes: 10,
      });

      const blob = byPath.get('uploadBytes:files/{uid}/blob.txt')!;
      expect(blob.storageUpload).toEqual({
        contentType: 'text/plain',
        sizeBytes: 7,
      });

      const raw = byPath.get('uploadString:files/{uid}/raw.txt')!;
      expect(raw.storageUpload).toEqual({ sizeBytes: 5 });

      const b64 = byPath.get('uploadString:files/{uid}/b64.bin')!;
      expect(b64.storageUpload).toEqual({ contentType: 'text/plain', sizeBytes: 5 });

      const b64url = byPath.get('uploadString:files/{uid}/b64url.bin')!;
      expect(b64url.storageUpload).toEqual({ sizeBytes: 5 });

      const dataUrl = byPath.get('uploadString:files/{uid}/inline.svg')!;
      expect(dataUrl.storageUpload).toEqual({
        contentType: 'image/svg+xml',
        sizeBytes: 6,
      });

      const updated = byPath.get('updateMetadata:files/{uid}/fixed.bin')!;
      expect(updated.storageUpload?.customMetadataKeys).toEqual(['__proto__', 'owner']);
      const customMeta = updated.storageUpload?.customMetadata ?? {};
      expect(Object.getPrototypeOf(customMeta)).toBe(Object.prototype);
      expect(Object.hasOwn(customMeta, '__proto__')).toBe(true);
      expect(customMeta['__proto__']).toEqual({
        name: '__proto__',
        kind: 'string',
        literal: 'safe',
      });
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, 'process', descriptor);
      }
    }
  });

  test('omits sizeBytes when upload format or payload buffer is dynamic', () => {
    const usage = extractSdkUsage({
      root: '/virtual/app',
      files: {
        'dynamic.ts': `
          import { getStorage, ref, uploadBytes, uploadString, type StringFormat } from 'pyric/storage';
          const storage = getStorage();
          export async function uploadUnknown(bytes: Uint8Array, text: string, fmt: StringFormat) {
            await uploadBytes(ref(storage, 'files/a.bin'), bytes);
            await uploadString(ref(storage, 'files/b.txt'), 'aGVsbG8=', fmt, { contentType: 'text/plain' });
            await uploadString(ref(storage, 'files/c.txt'), text, 'raw', { contentType: 'text/plain' });
          }
        `,
      },
    });

    const a = usage.operations.find((op) => op.path === 'files/a.bin')!;
    expect(a.storageUpload).toBeUndefined();

    const b = usage.operations.find((op) => op.path === 'files/b.txt')!;
    expect(b.storageUpload).toEqual({ contentType: 'text/plain' });

    const c = usage.operations.find((op) => op.path === 'files/c.txt')!;
    expect(c.storageUpload).toEqual({ contentType: 'text/plain' });
  });
});
