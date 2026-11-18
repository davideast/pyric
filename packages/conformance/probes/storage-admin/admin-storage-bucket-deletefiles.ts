import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import type { Probe } from '../../rigs/types.ts';
import { loadOracleServiceAccount, oracleAppOptions } from '../../src/oracle-credential.ts';
import { resolveAdminStorageBucket } from '../../src/storage-probe-session.ts';

export interface AdminBucketDeleteFilesSubject {
  seedRelative(relativePath: string): Promise<void>;
  existsRelative(relativePath: string): Promise<boolean>;
  deleteSubPrefix(subPrefix: string, options?: { maxResults?: number; force?: boolean }): Promise<void>;
}

export async function observeAdminBucketDeleteFiles(
  subject: AdminBucketDeleteFilesSubject,
): Promise<Record<string, unknown>> {
  const cappedFiles = ['capped/a.bin', 'capped/b.bin', 'capped/c.bin'];
  const fullFiles = ['full/one.bin', 'full/nested/two.bin'];
  const siblingFile = 'sibling/keep.bin';

  for (const rel of [...cappedFiles, ...fullFiles, siblingFile]) {
    await subject.seedRelative(rel);
  }

  await subject.deleteSubPrefix('capped/', { maxResults: 2 });
  const remainingAfterCapped: string[] = [];
  for (const rel of cappedFiles) {
    if (await subject.existsRelative(rel)) {
      remainingAfterCapped.push(rel);
    }
  }
  const siblingAfterCapped = await subject.existsRelative(siblingFile);

  await subject.deleteSubPrefix('full/');
  const remainingAfterFull: string[] = [];
  for (const rel of fullFiles) {
    if (await subject.existsRelative(rel)) {
      remainingAfterFull.push(rel);
    }
  }
  const siblingAfterFull = await subject.existsRelative(siblingFile);

  let emptyPrefixThrew = false;
  try {
    await subject.deleteSubPrefix('empty-nonexistent/');
  } catch {
    emptyPrefixThrew = true;
  }

  return {
    cappedMaxResults2: {
      seededCount: cappedFiles.length,
      remainingRelativeNames: remainingAfterCapped,
      siblingStillExists: siblingAfterCapped,
    },
    fullPrefixDelete: {
      seededCount: fullFiles.length,
      remainingRelativeNames: remainingAfterFull,
      siblingStillExists: siblingAfterFull,
    },
    emptyPrefixDelete: {
      threw: emptyPrefixThrew,
    },
  };
}

export const probe: Probe = {
  rig: 'storage-admin',
  matrixRow: 'storage-admin #8',
  rowIds: ['storage-admin#8'],
  description:
    'firebase-admin Bucket.deleteFiles({ prefix, maxResults, force }): observes prefix-scoped deletion, maxResults bounding, sibling prefix isolation, and empty-prefix behavior.',
  async observe() {
    const sa = await loadOracleServiceAccount();
    const bucketName = await resolveAdminStorageBucket(sa, process.env);
    const runTag = `admin_deletefiles_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const app = initializeApp(
      { ...oracleAppOptions(sa), storageBucket: bucketName },
      `admin-storage-deletefiles-${runTag}`,
    );
    const bucket = getStorage(app).bucket();
    const basePrefixWithSlash = `pyric_oracle/${runTag}/`;
    const createdPaths: string[] = [];

    try {
      return await observeAdminBucketDeleteFiles({
        async seedRelative(relativePath) {
          const fullPath = `${basePrefixWithSlash}${relativePath}`;
          createdPaths.push(fullPath);
          await bucket
            .file(fullPath)
            .save(Buffer.from([0x64, 0x66]), { contentType: 'application/octet-stream', resumable: false });
        },
        async existsRelative(relativePath) {
          const [exists] = await bucket.file(`${basePrefixWithSlash}${relativePath}`).exists();
          return exists;
        },
        async deleteSubPrefix(subPrefix, options) {
          const query: { prefix: string; maxResults?: number; force?: boolean } = {
            prefix: `${basePrefixWithSlash}${subPrefix}`,
          };
          if (options?.maxResults !== undefined) {
            query.maxResults = options.maxResults;
          }
          if (options?.force !== undefined) {
            query.force = options.force;
          }
          await bucket.deleteFiles(query);
        },
      });
    } finally {
      for (const path of createdPaths) {
        await bucket
          .file(path)
          .delete()
          .catch(() => undefined);
      }
      await deleteApp(app).catch(() => undefined);
    }
  },
};
