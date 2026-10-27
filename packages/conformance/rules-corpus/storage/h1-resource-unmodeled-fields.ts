/**
 * ─── Candidate scenario (hunt H1, ST-H1-1): h1-resource-unmodeled-fields ──────
 * Shows the seven `unprobeable` resource fields are probeable: the Rules Test
 * API's `resource` is a free-form map, so a case that carries the field and a
 * rule that reads it ALLOWs in production, while pyric's binding (and the
 * replay's `toEvaluationInput`) drops the field and DENIES. The absent-field
 * cases pin the other half (production errors on an absent property).
 * `StorageResourceShape` does not type these fields, hence the cast.
 */
import type { StorageScenarioRecord, StorageTestCase } from './types.ts';

const stored = {
  size: 5,
  contentType: 'text/plain',
  name: 'res/x.bin',
  bucket: 'pyric-default',
  md5Hash: 'MD5HASH==',
  crc32c: 'CRC32C==',
  etag: 'ETAG123',
  contentDisposition: 'inline',
  contentEncoding: 'gzip',
  contentLanguage: 'en',
  cacheControl: 'no-cache',
} as unknown as NonNullable<StorageTestCase['existingResource']>;

const fields = ['md5Hash', 'crc32c', 'etag', 'contentDisposition', 'contentEncoding', 'contentLanguage', 'cacheControl'] as const;

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-H1-RESOURCE-FIELDS',
  rationale: 'The seven resource fields marked unprobeable are readable through a Rules Test API resource map; pyric drops them.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
${fields.map((f) => `    match /res/${f}.bin { allow get: if resource.${f} == ${JSON.stringify((stored as Record<string, string>)[f]).replace(/"/g, "'")}; }`).join('\n')}
  }
}`,
  cases: [
    ...fields.map((f): StorageTestCase => ({
      description: `present: resource.${f} reads the stored value (pyric DENY)`,
      expectation: 'ALLOW',
      method: 'get',
      path: `res/${f}.bin`,
      existingResource: { ...stored, name: `res/${f}.bin` },
    })),
    { description: 'absent: resource.md5Hash on a resource without it denies (pyric DENY)', expectation: 'DENY', method: 'get', path: 'res/md5Hash.bin', existingResource: { size: 5, name: 'res/md5Hash.bin' } },
    { description: 'absent: resource.cacheControl on a resource without it denies (pyric DENY)', expectation: 'DENY', method: 'get', path: 'res/cacheControl.bin', existingResource: { size: 5, name: 'res/cacheControl.bin' } },
  ],
};
