import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import type { Probe } from '../../rigs/types.ts';
import { loadOracleServiceAccount, oracleAppOptions } from '../../src/oracle-credential.ts';
import { resolveAdminStorageBucket } from '../../src/storage-probe-session.ts';

export interface BucketGetFilesPageObservation {
  relativeNames: string[];
  relativePrefixes: string[];
  nextQueryIsNull: boolean;
  nextQueryHasPageToken: boolean;
  nextQueryMatchesInputPrefix: boolean;
  apiResponseKind: string | null;
  apiResponseHasItemsProperty: boolean;
  firstFileMetadataPopulated: boolean | null;
}

export interface AdminBucketGetFilesSubject {
  seedRelative(relativePath: string): Promise<void>;
  queryVerbatimSubPrefix(subPrefix: string): Promise<BucketGetFilesPageObservation>;
  queryDelimiterRoot(): Promise<BucketGetFilesPageObservation>;
  queryTwoPagesWithDelimiter(maxResults: number): Promise<{
    page1: BucketGetFilesPageObservation;
    page2: BucketGetFilesPageObservation;
  }>;
}

export async function observeAdminBucketGetFiles(
  subject: AdminBucketGetFilesSubject,
): Promise<Record<string, unknown>> {
  const seeded = [
    'items/123/a.bin',
    'items/123/b/c.bin',
    'items/124/a.bin',
    'items/2/x.bin',
    'readme.txt',
    'items',
  ];
  for (const rel of seeded) {
    await subject.seedRelative(rel);
  }

  const partialFolderPrefix = await subject.queryVerbatimSubPrefix('items/12');
  const slashFolderPrefix = await subject.queryVerbatimSubPrefix('items/123/');
  const delimiterRollup = await subject.queryDelimiterRoot();
  const paginated = await subject.queryTwoPagesWithDelimiter(2);

  return {
    partialFolderPrefix,
    slashFolderPrefix,
    delimiterRollup,
    paginated,
  };
}

export function summarizeBucketGetFilesTuple(
  basePrefixWithSlash: string,
  inputPrefix: string,
  files: ReadonlyArray<{ name: string; metadata?: Record<string, unknown> }>,
  nextQuery: Record<string, unknown> | null | undefined,
  apiResponse: unknown,
): BucketGetFilesPageObservation {
  const relativeNames = files.map((f) => {
    if (f.name.startsWith(basePrefixWithSlash)) {
      return f.name.slice(basePrefixWithSlash.length);
    }
    return f.name;
  });

  let apiRecord: Record<string, unknown> = {};
  if (typeof apiResponse === 'object' && apiResponse !== null) {
    apiRecord = apiResponse as Record<string, unknown>;
  }
  let rawPrefixes: string[] = [];
  if (Array.isArray(apiRecord.prefixes)) {
    rawPrefixes = apiRecord.prefixes as string[];
  }
  const relativePrefixes = rawPrefixes.map((p) => {
    if (p.startsWith(basePrefixWithSlash)) {
      return p.slice(basePrefixWithSlash.length);
    }
    return p;
  });

  let apiResponseKind: string | null = null;
  if (typeof apiRecord.kind === 'string') {
    apiResponseKind = apiRecord.kind;
  }

  let firstFileMetadataPopulated: boolean | null = null;
  if (files.length > 0) {
    const firstMeta = files[0].metadata;
    firstFileMetadataPopulated =
      firstMeta !== undefined && firstMeta !== null && Object.keys(firstMeta).length > 0;
  }

  let nextQueryHasPageToken = false;
  let nextQueryMatchesInputPrefix = false;
  if (nextQuery !== null && nextQuery !== undefined) {
    nextQueryHasPageToken =
      typeof nextQuery.pageToken === 'string' && nextQuery.pageToken.length > 0;
    nextQueryMatchesInputPrefix = nextQuery.prefix === inputPrefix;
  }

  return {
    relativeNames,
    relativePrefixes,
    nextQueryIsNull: nextQuery === null || nextQuery === undefined,
    nextQueryHasPageToken,
    nextQueryMatchesInputPrefix,
    apiResponseKind,
    apiResponseHasItemsProperty: Object.prototype.hasOwnProperty.call(apiRecord, 'items'),
    firstFileMetadataPopulated,
  };
}

export const probe: Probe = {
  rig: 'storage-admin',
  matrixRow: 'storage-admin #7',
  rowIds: ['storage-admin#7'],
  description:
    'firebase-admin Bucket.getFiles({ prefix, delimiter, maxResults, pageToken, autoPaginate }): observes verbatim prefix matching, delimiter prefix roll-up, [files, nextQuery, apiResponse] tuple shape, and pageToken pagination.',
  async observe() {
    const sa = await loadOracleServiceAccount();
    const bucketName = await resolveAdminStorageBucket(sa, process.env);
    const runTag = `admin_getfiles_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const app = initializeApp(
      { ...oracleAppOptions(sa), storageBucket: bucketName },
      `admin-storage-getfiles-${runTag}`,
    );
    const bucket = getStorage(app).bucket();
    const basePrefix = `pyric_oracle/${runTag}`;
    const basePrefixWithSlash = `${basePrefix}/`;
    const createdPaths: string[] = [];

    try {
      return await observeAdminBucketGetFiles({
        async seedRelative(relativePath) {
          const fullPath = `${basePrefixWithSlash}${relativePath}`;
          createdPaths.push(fullPath);
          await bucket
            .file(fullPath)
            .save(Buffer.from([0x67, 0x66]), { contentType: 'application/octet-stream', resumable: false });
        },
        async queryVerbatimSubPrefix(subPrefix) {
          const inputPrefix = `${basePrefixWithSlash}${subPrefix}`;
          const [files, nextQuery, apiResponse] = await bucket.getFiles({ prefix: inputPrefix });
          return summarizeBucketGetFilesTuple(
            basePrefixWithSlash,
            inputPrefix,
            files as unknown as ReadonlyArray<{ name: string; metadata?: Record<string, unknown> }>,
            nextQuery as Record<string, unknown> | null | undefined,
            apiResponse,
          );
        },
        async queryDelimiterRoot() {
          const [files, nextQuery, apiResponse] = await bucket.getFiles({
            prefix: basePrefixWithSlash,
            delimiter: '/',
          });
          return summarizeBucketGetFilesTuple(
            basePrefixWithSlash,
            basePrefixWithSlash,
            files as unknown as ReadonlyArray<{ name: string; metadata?: Record<string, unknown> }>,
            nextQuery as Record<string, unknown> | null | undefined,
            apiResponse,
          );
        },
        async queryTwoPagesWithDelimiter(maxResults) {
          const [files1, next1, api1] = await bucket.getFiles({
            prefix: basePrefixWithSlash,
            delimiter: '/',
            maxResults,
            autoPaginate: false,
          });
          const page1 = summarizeBucketGetFilesTuple(
            basePrefixWithSlash,
            basePrefixWithSlash,
            files1 as unknown as ReadonlyArray<{ name: string; metadata?: Record<string, unknown> }>,
            next1 as Record<string, unknown> | null | undefined,
            api1,
          );
          if (!next1) {
            throw new Error('expected first paginated Bucket.getFiles call to return nextQuery');
          }
          const [files2, next2, api2] = await bucket.getFiles({
            ...(next1 as Record<string, unknown>),
            autoPaginate: false,
          });
          const page2 = summarizeBucketGetFilesTuple(
            basePrefixWithSlash,
            basePrefixWithSlash,
            files2 as unknown as ReadonlyArray<{ name: string; metadata?: Record<string, unknown> }>,
            next2 as Record<string, unknown> | null | undefined,
            api2,
          );
          return { page1, page2 };
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
