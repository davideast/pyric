import { describe, expect, test } from 'bun:test';
import { extractAccessSites } from '../../../../src/assurance-surface/code/extractor.js';
import { renderPath } from '../../../../src/assurance-surface/code/paths.js';
import { STORAGE_SERVICE_MODEL } from '../../../../src/assurance-surface/code/service-models/storage.js';
import { extractSdkUsage } from '../../../../src/assurance-surface/code/usage-index.js';
import { alternatives, type AVal } from '../../../../src/assurance-surface/code/values.js';
import { renderResourcePattern } from '../../../../src/sandbox/internal/resource-pattern.js';
import { harness } from '../harness.js';

function refSummary(v: AVal): string[] {
  return alternatives(v).map((a) => {
    if (a.k !== 'ref') return a.k;
    const { path } = renderPath(a.service, a.segments);
    return `${a.service}[${a.resourceId}]:${a.refKind}:${path}`;
  });
}

describe('STORAGE_SERVICE_MODEL', () => {
  test('declares Storage modules, handle factories, ref constructors, reads, and writes', () => {
    expect(STORAGE_SERVICE_MODEL.service).toBe('storage');
    expect(STORAGE_SERVICE_MODEL.defaultRefKind).toBe('object');
    expect(STORAGE_SERVICE_MODEL.queryBaseRefKind).toBe('object');
    expect(STORAGE_SERVICE_MODEL.modules).toEqual([
      'firebase/storage',
      '@firebase/storage',
      'pyric/storage',
      'firebase-admin/storage',
      'pyric-admin/storage',
    ]);
    expect(STORAGE_SERVICE_MODEL.handleFactories.getStorage).toEqual({
      resourceArgIndex: 1,
      singleStringArgIsResource: true,
    });
    expect(STORAGE_SERVICE_MODEL.handleFactories.getAdminStorage).toEqual({
      resourceArgIndex: 1,
      singleStringArgIsResource: true,
    });
    expect(STORAGE_SERVICE_MODEL.refConstructors.ref).toEqual({ refKind: 'object' });
    expect(STORAGE_SERVICE_MODEL.refConstructors.refFromURL).toEqual({
      refKind: 'object',
      mode: 'url',
    });
    expect(Object.keys(STORAGE_SERVICE_MODEL.operations)).toEqual(
      expect.arrayContaining([
        'uploadBytes',
        'uploadBytesResumable',
        'uploadString',
        'deleteObject',
        'updateMetadata',
        'getDownloadURL',
        'getBytes',
        'getBlob',
        'getStream',
        'getMetadata',
        'list',
        'listAll',
      ]),
    );
  });

  test('traces default/named buckets, nested ref(parentRef, childPath), gs:// overrides, and non-literal bucket fallback', () => {
    const h = harness({
      'storage.ts': `
        import { getStorage, ref } from 'pyric/storage';
        import { getAuth } from 'pyric/auth';
        declare const app: unknown;
        declare const dynamicBucketUrl: string;

        const uid = getAuth().currentUser!.uid;
        const defaultStorage = getStorage(app);
        const mediaStorage = getStorage(app, 'gs://media-bucket');
        const shorthandStorage = getStorage('gs://archive-bucket');
        const dynamicStorage = getStorage(app, dynamicBucketUrl);

        const folderRef = ref(mediaStorage, 'files/' + uid);
        export const rootChild = ref(defaultStorage, 'files/' + uid + '/avatar.png');
        export const nestedChild = ref(folderRef, 'avatar.png');
        export const gsOverride = ref(defaultStorage, 'gs://override-bucket/orgs/acme/logo.svg');
        export const dynamicBucketRef = ref(dynamicStorage, 'items/1.bin');
        export const shorthandRef = ref(shorthandStorage, 'backups/latest.tar');
      `,
    });

    expect(refSummary(h.ev.eval(h.ident('storage.ts', 'rootChild', 0)))).toEqual([
      'storage[(default)]:object:files/{uid}/avatar.png',
    ]);
    expect(refSummary(h.ev.eval(h.ident('storage.ts', 'nestedChild', 0)))).toEqual([
      'storage[media-bucket]:object:files/{uid}/avatar.png',
    ]);
    expect(refSummary(h.ev.eval(h.ident('storage.ts', 'gsOverride', 0)))).toEqual([
      'storage[override-bucket]:object:orgs/acme/logo.svg',
    ]);
    expect(refSummary(h.ev.eval(h.ident('storage.ts', 'shorthandRef', 0)))).toEqual([
      'storage[archive-bucket]:object:backups/latest.tar',
    ]);

    const dynamicVal = h.ev.force(h.ev.eval(h.ident('storage.ts', 'dynamicBucketRef', 0)));
    expect(dynamicVal.k).toBe('ref');
    if (dynamicVal.k === 'ref') {
      expect(dynamicVal.resourceId).toBe('(default)');
      expect(dynamicVal.notes.some((n) => n.includes('getStorage()'))).toBe(true);
    }
  });

  test('traces all Storage read and write operations by default, counts reads/writes, and honors includeReads: false', () => {
    const files = {
      'ops.ts': `
        import {
          getStorage,
          ref,
          uploadBytes,
          uploadBytesResumable,
          uploadString,
          deleteObject,
          updateMetadata,
          getDownloadURL,
          getBytes,
          getBlob,
          getStream,
          getMetadata,
          list,
          listAll,
        } from 'firebase/storage';
        import { getAuth } from 'firebase/auth';

        const storage = getStorage(undefined, 'gs://assets-bucket');

        export async function exerciseStorage(orgId: string) {
          const uid = getAuth().currentUser!.uid;
          const avatarRef = ref(storage, 'files/' + uid + '/avatar.png');
          const folderRef = ref(storage, 'orgs/' + orgId);

          await uploadBytes(avatarRef, new Uint8Array(128), { contentType: 'image/png' });
          await uploadBytesResumable(ref(folderRef, 'report.pdf'), new Uint8Array(256), {
            contentType: 'application/pdf',
          });
          await uploadString(ref(folderRef, 'note.txt'), 'hello world');
          await updateMetadata(avatarRef, { customMetadata: { owner: uid } });
          await deleteObject(ref(folderRef, 'old.txt'));

          await getDownloadURL(avatarRef);
          await getBytes(avatarRef, 4096);
          await getBlob(avatarRef);
          getStream(avatarRef);
          await getMetadata(avatarRef);
          await list(folderRef, { maxResults: 10 });
          await listAll(folderRef);
        }
      `,
    };

    const reportAll = extractAccessSites({ root: '/virtual/app', files });
    expect(reportAll.counts).toEqual({
      total: 12,
      writes: 5,
      reads: 7,
      resolved: 12,
      partial: 0,
      unresolved: 0,
    });
    expect(reportAll.accessSites.map((s) => s.op)).toEqual([
      'uploadBytes',
      'uploadBytesResumable',
      'uploadString',
      'updateMetadata',
      'deleteObject',
      'getDownloadURL',
      'getBytes',
      'getBlob',
      'getStream',
      'getMetadata',
      'list',
      'listAll',
    ]);

    const writesOnly = extractAccessSites({ root: '/virtual/app', files, includeReads: false });
    expect(writesOnly.counts).toEqual({
      total: 5,
      writes: 5,
      reads: 0,
      resolved: 5,
      partial: 0,
      unresolved: 0,
    });
    expect(writesOnly.accessSites.map((s) => s.op)).toEqual([
      'uploadBytes',
      'uploadBytesResumable',
      'uploadString',
      'updateMetadata',
      'deleteObject',
    ]);
  });

  test('traces Admin Storage bucket().file() receiver chains across firebase-admin/storage and pyric-admin/storage', () => {
    const usage = extractSdkUsage({
      root: '/virtual/app',
      files: {
        'admin-storage.ts': `
          import { getStorage } from 'firebase-admin/storage';
          import { getAdminStorage } from 'pyric-admin/storage';
          declare const app: unknown;

          const adminStorage = getStorage(app);
          const defaultAdmin = getAdminStorage(app, 'gs://default-exports');

          export async function writeExport(orgId: string) {
            const bucket = adminStorage.bucket('gs://exports-bucket');
            const reportFile = bucket.file('orgs/' + orgId + '/summary.csv');
            await reportFile.save('id,total\\n1,42\\n', {
              contentType: 'text/csv',
              metadata: { orgId },
            });
            await defaultAdmin.bucket().file('orgs/' + orgId + '/old.csv').delete();
            await reportFile.download();
          }
        `,
      },
    });

    const refPaths = usage.refs.map((r) => `${r.pattern.resourceId}:${renderResourcePattern(r.pattern)}`);
    expect(refPaths).toEqual([
      'exports-bucket:orgs/{orgId}/summary.csv',
      'default-exports:orgs/{orgId}/old.csv',
    ]);
    expect(usage.operations.map((op) => ({ op: op.op, path: op.path, size: op.storageUpload?.sizeBytes, mime: op.storageUpload?.contentType }))).toEqual([
      { op: 'uploadBytes', path: 'orgs/{orgId}/summary.csv', size: 14, mime: 'text/csv' },
      { op: 'deleteObject', path: 'orgs/{orgId}/old.csv', size: undefined, mime: undefined },
      { op: 'getBytes', path: 'orgs/{orgId}/summary.csv', size: undefined, mime: undefined },
    ]);
  });

  test('traces refFromURL and ref with Firebase download, GCS, and local storage HTTP(S) URLs', () => {
    const report = extractAccessSites({
      root: '/virtual/app',
      files: {
        'urls.ts': `
          import { getStorage, ref, refFromURL, getDownloadURL, deleteObject, getBytes } from 'firebase/storage';
          import { getAuth } from 'firebase/auth';

          const storage = getStorage();

          export async function readFromUrls(orgId: string) {
            const uid = getAuth().currentUser!.uid;
            const dlRef = refFromURL(
              storage,
              'https://firebasestorage.googleapis.com/v0/b/media-bucket/o/files%2F' + uid + '%2Fdoc.pdf?alt=media',
            );
            const gcsRef = refFromURL(
              storage,
              'https://storage.googleapis.com/assets-bucket/orgs/' + orgId + '/logo.png',
            );
            const localRef = ref(
              storage,
              'http://127.0.0.1:4000/__pyric/storage/v0/b/local-bucket/o/files%2F' + uid + '%2Fnote.txt',
            );
            await getDownloadURL(dlRef);
            await deleteObject(gcsRef);
            await getBytes(localRef);
          }
        `,
      },
    });

    expect(
      report.accessSites.map((s) => ({
        op: s.op,
        resourceId: s.resourceId,
        path: s.path,
        resolution: s.resolution,
      })),
    ).toEqual([
      {
        op: 'getDownloadURL',
        resourceId: 'media-bucket',
        path: 'files/{uid}/doc.pdf',
        resolution: 'resolved',
      },
      {
        op: 'deleteObject',
        resourceId: 'assets-bucket',
        path: 'orgs/{orgId}/logo.png',
        resolution: 'resolved',
      },
      {
        op: 'getBytes',
        resourceId: 'local-bucket',
        path: 'files/{uid}/note.txt',
        resolution: 'resolved',
      },
    ]);
  });
});
