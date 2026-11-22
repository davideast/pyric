/**
 * Public `@pyric/rules` `storageRules().simulate()` coverage for
 * `StorageRequestResource` `md5Hash`, `crc32c`, and `etag` (#3258).
 */
import { describe, expect, test } from 'bun:test';
import { storageRules, type StorageCase } from '../../src/index.js';

const BUCKET = 'demo-app.appspot.com';

describe('storageRules().simulate() requestResource digests and etag (#3258)', () => {
  const ruleset = storageRules(
    [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /items/{id} {',
      "      allow create: if request.resource.md5Hash == 'asHla8ePAxBZvnvoVFIsTA=='",
      "        && request.resource.crc32c == 'T037qw=='",
      '        && request.resource.etag == null;',
      '      allow update: if request.resource.md5Hash == resource.md5Hash',
      '        && request.resource.crc32c == resource.crc32c',
      '        && request.resource.etag is string',
      '        && request.resource.etag == resource.etag;',
      '    }',
      '  }',
      '}',
    ].join('\n'),
    { bucket: BUCKET },
  );

  test('evaluates md5Hash, crc32c, and null/string etag on create and update cases', () => {
    const summary = ruleset.simulate([
      {
        description: 'create with matching digests and null etag',
        expectation: 'ALLOW',
        method: 'create',
        path: 'items/six.bin',
        requestResource: {
          size: 6,
          md5Hash: 'asHla8ePAxBZvnvoVFIsTA==',
          crc32c: 'T037qw==',
          etag: null,
        },
      },
      {
        description: 'update carrying stored digests and string etag',
        expectation: 'ALLOW',
        method: 'update',
        path: 'items/six.bin',
        requestResource: {
          size: 6,
          md5Hash: 'asHla8ePAxBZvnvoVFIsTA==',
          crc32c: 'T037qw==',
          etag: 'MToy',
        },
        resource: {
          size: 6,
          md5Hash: 'asHla8ePAxBZvnvoVFIsTA==',
          crc32c: 'T037qw==',
          etag: 'MToy',
        },
      },
    ]);
    expect(summary.unsupported).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBe(2);
  });

  test('refuses non-string md5Hash or crc32c on requestResource', () => {
    const summary = ruleset.simulate([
      {
        description: 'numeric md5Hash',
        expectation: 'DENY',
        method: 'create',
        path: 'items/six.bin',
        requestResource: { size: 6, md5Hash: 123 as unknown as string },
      } as StorageCase,
      {
        description: 'boolean crc32c',
        expectation: 'DENY',
        method: 'create',
        path: 'items/six.bin',
        requestResource: { size: 6, crc32c: true as unknown as string },
      } as StorageCase,
    ]);
    expect(summary.unsupported).toBe(2);
    expect(summary.cases[0]?.reasons[0]).toContain('requestResource.md5Hash must be a string');
    expect(summary.cases[1]?.reasons[0]).toContain('requestResource.crc32c must be a string');
  });
});
