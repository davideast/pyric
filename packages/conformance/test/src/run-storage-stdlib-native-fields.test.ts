import { describe, expect, test } from 'bun:test';
import { nativeRules } from '../../src/run-storage-stdlib-native-fields.ts';
import type { GcsObject } from '../../src/storage-stdlib-real-objects.ts';

const object = (name: string): GcsObject => ({
  name,
  bucket: 'bucket',
  generation: '10',
  metageneration: '2',
  size: '5',
  md5Hash: 'md5',
  crc32c: 'crc',
  etag: 'etag',
  timeCreated: '2026-07-21T00:00:00.000Z',
  updated: '2026-07-21T00:00:01.000Z',
});

describe('Storage native-field probe rules', () => {
  test('pins server fields and keeps excluded incoming fields as negative controls', () => {
    const rules = nativeRules('test-run', {
      'stored-exact': object('stored-exact'),
      'identity-mismatch': object('identity-mismatch'),
      'hash-mismatch': object('hash-mismatch'),
      'time-mismatch': object('time-mismatch'),
    });

    expect(rules).toContain('resource.generation == 10');
    expect(rules).toContain('resource.md5Hash == "md5"');
    expect(rules).toContain('incoming-excluded-version.bin');
    expect(rules).toContain('request.resource.generation == 0');
  });
});
