/**
 * Declarative Admin Storage, Bucket, and File method schemas composed from
 * `../argument-generator/argument-combinators.js` without modifying the shared
 * combinator module.
 */

import { Readable } from 'node:stream';
import {
  emitFieldCandidates,
  makeCandidate,
  methodSchema,
  objectSchema,
  prefixedIdentifierSchema,
  scalarSchema,
  stringMapSchema,
  type CandidateValue,
  type FieldSchema,
  type MethodSchema,
} from '../argument-generator/argument-combinators.js';

export const STORAGE_DIFF_BUCKET = 'demo-project.appspot.com';
export const STORAGE_EXISTING_PATH = 'docs/existing.txt';
export const STORAGE_MISSING_PATH = 'docs/missing.txt';
export const STORAGE_FUTURE_EXPIRES_MS = Date.UTC(2035, 0, 1, 0, 0, 0);

function withExtraObjectCandidates(
  obj: FieldSchema,
  extra: () => readonly CandidateValue[],
): FieldSchema {
  return scalarSchema({
    extraCandidates: () => [...emitFieldCandidates(obj, 'obj'), ...extra()],
  });
}

export interface StorageSchemaContext {
  readonly makeDestBucket: () => unknown;
  readonly makeDestFile: () => unknown;
}

export interface StorageMethodSchemas {
  readonly bucket: MethodSchema;
  readonly file: MethodSchema;
  readonly getFiles: MethodSchema;
  readonly deleteFiles: MethodSchema;
  readonly save: MethodSchema;
  readonly download: MethodSchema;
  readonly delete: MethodSchema;
  readonly exists: MethodSchema;
  readonly getMetadata: MethodSchema;
  readonly setMetadata: MethodSchema;
  readonly copy: MethodSchema;
  readonly move: MethodSchema;
  readonly getSignedUrl: MethodSchema;
  readonly createReadStream: MethodSchema;
  readonly createWriteStream: MethodSchema;
  readonly createResumableUpload: MethodSchema;
}

export function buildStorageMethodSchemas(ctx: StorageSchemaContext): StorageMethodSchemas {
  const bucketSchema = prefixedIdentifierSchema({
    prefixes: ['', 'gs://'],
    bodies: ['', '/', 'archive-bucket', 'archive-bucket/'],
  });

  const filePathSchema = scalarSchema({
    extraCandidates: () => [
      makeCandidate('path="docs/item-1.txt"', () => 'docs/item-1.txt'),
      makeCandidate('path="nested/a/b/c.bin"', () => 'nested/a/b/c.bin'),
      makeCandidate('path="file with spaces.txt"', () => 'file with spaces.txt'),
      makeCandidate('path="gs://other-bucket/sub/file.txt"', () => 'gs://other-bucket/sub/file.txt'),
    ],
  });

  const listingQueryObj = objectSchema({
    validBase: () => ({ prefix: 'docs/' }),
    fields: {
      prefix: scalarSchema({
        extraCandidates: () => [
          makeCandidate('prefix="docs/"', () => 'docs/'),
          makeCandidate('prefix="missing/"', () => 'missing/'),
        ],
      }),
      delimiter: scalarSchema({
        extraCandidates: () => [makeCandidate('delimiter="/"', () => '/')],
      }),
      maxResults: scalarSchema({
        extraCandidates: () => [
          makeCandidate('maxResults=2', () => 2),
          makeCandidate('maxResults=-1', () => -1),
        ],
      }),
      pageToken: scalarSchema(),
      autoPaginate: scalarSchema(),
    },
  });

  const deleteQueryObj = objectSchema({
    validBase: () => ({ prefix: 'docs/' }),
    fields: {
      prefix: scalarSchema({
        extraCandidates: () => [
          makeCandidate('prefix="docs/"', () => 'docs/'),
          makeCandidate('prefix="none/"', () => 'none/'),
        ],
      }),
      delimiter: scalarSchema({
        extraCandidates: () => [makeCandidate('delimiter="/"', () => '/')],
      }),
      maxResults: scalarSchema(),
      force: scalarSchema(),
    },
  });

  const saveOptionsObj = objectSchema({
    validBase: () => ({ contentType: 'text/plain' }),
    fields: {
      contentType: scalarSchema({
        extraCandidates: () => [makeCandidate('contentType="text/plain"', () => 'text/plain')],
      }),
      resumable: scalarSchema(),
      metadata: objectSchema({
        validBase: () => ({ cacheControl: 'public, max-age=60' }),
        fields: {
          contentType: scalarSchema(),
          cacheControl: scalarSchema(),
          metadata: stringMapSchema({ sampleKey: 'k1', validValue: 'v1' }),
        },
      }),
    },
  });

  const downloadOptionsObj = objectSchema({
    validBase: () => ({}),
    fields: {
      start: scalarSchema({
        extraCandidates: () => [
          makeCandidate('start=2', () => 2),
          makeCandidate('start=-2', () => -2),
        ],
      }),
      end: scalarSchema({
        extraCandidates: () => [
          makeCandidate('end=4', () => 4),
          makeCandidate('end=-3', () => -3),
        ],
      }),
      validation: scalarSchema({
        extraCandidates: () => [
          makeCandidate('validation="md5"', () => 'md5'),
          makeCandidate('validation="crc32c"', () => 'crc32c'),
        ],
      }),
    },
  });

  const metadataPatchObj = objectSchema({
    validBase: () => ({ contentType: 'text/plain' }),
    fields: {
      contentType: scalarSchema({
        extraCandidates: () => [makeCandidate('contentType="application/json"', () => 'application/json')],
      }),
      cacheControl: scalarSchema(),
      contentDisposition: scalarSchema(),
      contentEncoding: scalarSchema(),
      contentLanguage: scalarSchema(),
      metadata: stringMapSchema({ sampleKey: 'tag', validValue: 'alpha' }),
    },
  });

  const destinationSchema = scalarSchema({
    extraCandidates: () => [
      makeCandidate('dest="docs/copied.txt"', () => 'docs/copied.txt'),
      makeCandidate('dest="gs://archive-bucket/copied.txt"', () => 'gs://archive-bucket/copied.txt'),
      makeCandidate('dest="gs://UpperBucket/a.txt"', () => 'gs://UpperBucket/a.txt'),
      makeCandidate('dest="gs://archive-bucket/"', () => 'gs://archive-bucket/'),
      makeCandidate('dest="https://example.com/a.txt"', () => 'https://example.com/a.txt'),
      makeCandidate('dest="gs://"', () => 'gs://'),
      makeCandidate('dest="gs:///missing-bucket"', () => 'gs:///missing-bucket'),
      makeCandidate('dest=Bucket', () => ctx.makeDestBucket()),
      makeCandidate('dest=File', () => ctx.makeDestFile()),
    ],
  });

  const copyOptionsObj = objectSchema({
    validBase: () => ({}),
    fields: {
      contentType: scalarSchema(),
      cacheControl: scalarSchema(),
      metadata: stringMapSchema({ sampleKey: 'copiedKey', validValue: 'copiedVal' }),
    },
  });

  const signedUrlOptionsObj = objectSchema({
    validBase: () => ({ action: 'read', expires: STORAGE_FUTURE_EXPIRES_MS }),
    fields: {
      action: scalarSchema({
        extraCandidates: () => [
          makeCandidate('action="read"', () => 'read'),
          makeCandidate('action="write"', () => 'write'),
          makeCandidate('action="delete"', () => 'delete'),
          makeCandidate('action="resumable"', () => 'resumable'),
        ],
      }),
      expires: scalarSchema({
        extraCandidates: () => [
          makeCandidate('expires=futureMs', () => STORAGE_FUTURE_EXPIRES_MS),
          makeCandidate('expires=futureDate', () => new Date(STORAGE_FUTURE_EXPIRES_MS)),
          makeCandidate('expires=futureIso', () => new Date(STORAGE_FUTURE_EXPIRES_MS).toISOString()),
          makeCandidate('expires=pastMs(1700000000000)', () => 1_700_000_000_000),
          makeCandidate('expires=invalidDateObj', () => new Date('not-a-date')),
          makeCandidate('expires="not-a-date"', () => 'not-a-date'),
          makeCandidate('expires=Infinity', () => Number.POSITIVE_INFINITY),
        ],
      }),
    },
  });

  return {
    bucket: methodSchema({
      name: 'bucket',
      parameters: [
        {
          name: 'name',
          validValue: () => STORAGE_DIFF_BUCKET,
          omitTrailingUndefined: true,
          schema: bucketSchema,
        },
      ],
    }),
    file: methodSchema({
      name: 'file',
      parameters: [
        {
          name: 'path',
          validValue: () => STORAGE_EXISTING_PATH,
          schema: filePathSchema,
        },
      ],
    }),
    getFiles: methodSchema({
      name: 'getFiles',
      parameters: [
        {
          name: 'query',
          validValue: () => ({ prefix: 'docs/' }),
          omitTrailingUndefined: true,
          schema: withExtraObjectCandidates(listingQueryObj, () => [
            makeCandidate('callback-fn', () => () => {}),
          ]),
        },
      ],
    }),
    deleteFiles: methodSchema({
      name: 'deleteFiles',
      parameters: [
        {
          name: 'query',
          validValue: () => ({ prefix: 'docs/' }),
          omitTrailingUndefined: true,
          schema: withExtraObjectCandidates(deleteQueryObj, () => [
            makeCandidate('callback-fn', () => () => {}),
          ]),
        },
      ],
    }),
    save: methodSchema({
      name: 'save',
      parameters: [
        {
          name: 'data',
          validValue: () => 'hello world',
          schema: scalarSchema({
            extraCandidates: () => [
              makeCandidate('Buffer("bytes")', () => Buffer.from('bytes', 'utf8')),
              makeCandidate('Uint8Array([1,2,3])', () => new Uint8Array([1, 2, 3])),
              makeCandidate('Set(["he","llo"])', () => new Set(['he', 'llo'])),
              makeCandidate('syncGenerator', () =>
                (function* () {
                  yield 'he';
                  yield Buffer.from('llo', 'utf8');
                })(),
              ),
              makeCandidate('asyncGenerator', () =>
                (async function* () {
                  yield 'he';
                  yield new Uint8Array([108, 108, 111]);
                })(),
              ),
              makeCandidate('Readable(["he","llo"])', () => Readable.from(['he', 'llo'])),
              makeCandidate('Set([123])', () => new Set([123])),
              makeCandidate('Readable([123])', () => Readable.from([123], { objectMode: true })),
            ],
          }),
        },
        {
          name: 'options',
          validValue: () => ({ contentType: 'text/plain' }),
          omitTrailingUndefined: true,
          schema: saveOptionsObj,
        },
      ],
    }),
    download: methodSchema({
      name: 'download',
      parameters: [
        {
          name: 'options',
          validValue: () => ({}),
          omitTrailingUndefined: true,
          schema: withExtraObjectCandidates(downloadOptionsObj, () => [
            makeCandidate('range+validation="md5"', () => ({
              start: 0,
              end: 3,
              validation: 'md5',
            })),
            makeCandidate('range+validation=true', () => ({
              start: 0,
              validation: true,
            })),
            makeCandidate('range+validation=false', () => ({
              start: 0,
              end: 3,
              validation: false,
            })),
          ]),
        },
      ],
    }),
    delete: methodSchema({
      name: 'delete',
      parameters: [],
    }),
    exists: methodSchema({
      name: 'exists',
      parameters: [],
    }),
    getMetadata: methodSchema({
      name: 'getMetadata',
      parameters: [],
    }),
    setMetadata: methodSchema({
      name: 'setMetadata',
      parameters: [
        {
          name: 'metadata',
          validValue: () => ({ contentType: 'text/plain' }),
          schema: withExtraObjectCandidates(metadataPatchObj, () => [
            makeCandidate('proto-custom-metadata', () => ({
              metadata: JSON.parse('{"__proto__":"safe","k":"v"}') as Record<string, string>,
            })),
            makeCandidate('unmodeled-storageClass', () => ({ storageClass: 'NEARLINE' })),
          ]),
        },
      ],
    }),
    copy: methodSchema({
      name: 'copy',
      parameters: [
        {
          name: 'destination',
          validValue: () => 'docs/copied.txt',
          schema: destinationSchema,
        },
        {
          name: 'options',
          validValue: () => ({ contentType: 'text/plain' }),
          omitTrailingUndefined: true,
          schema: copyOptionsObj,
        },
      ],
    }),
    move: methodSchema({
      name: 'move',
      parameters: [
        {
          name: 'destination',
          validValue: () => 'docs/moved.txt',
          schema: destinationSchema,
        },
        {
          name: 'options',
          validValue: () => ({}),
          omitTrailingUndefined: true,
          schema: scalarSchema(),
        },
      ],
    }),
    getSignedUrl: methodSchema({
      name: 'getSignedUrl',
      parameters: [
        {
          name: 'options',
          validValue: () => ({ action: 'read', expires: STORAGE_FUTURE_EXPIRES_MS }),
          schema: signedUrlOptionsObj,
        },
      ],
    }),
    createReadStream: methodSchema({
      name: 'createReadStream',
      parameters: [
        {
          name: 'options',
          validValue: () => ({}),
          omitTrailingUndefined: true,
          schema: withExtraObjectCandidates(downloadOptionsObj, () => [
            makeCandidate('range+validation=md5', () => ({
              start: 0,
              end: 3,
              validation: 'md5',
            })),
            makeCandidate('range+validation=true', () => ({
              start: 0,
              validation: true,
            })),
          ]),
        },
      ],
    }),
    createWriteStream: methodSchema({
      name: 'createWriteStream',
      parameters: [
        {
          name: 'options',
          validValue: () => ({ contentType: 'text/plain' }),
          omitTrailingUndefined: true,
          schema: saveOptionsObj,
        },
      ],
    }),
    createResumableUpload: methodSchema({
      name: 'createResumableUpload',
      parameters: [
        {
          name: 'options',
          validValue: () => ({ metadata: { contentType: 'text/plain' } }),
          omitTrailingUndefined: true,
          schema: objectSchema({
            validBase: () => ({ metadata: { contentType: 'text/plain' } }),
            fields: {
              metadata: scalarSchema(),
              origin: scalarSchema(),
            },
          }),
        },
      ],
    }),
  };
}
