import { describe, expect, test } from 'bun:test';
import { parseToAST } from '../../src/grammar/FirestoreParser.js';
import { isStorageServiceName, topLevelMatches } from '../../src/grammar/service-blocks.js';

describe('service-blocks', () => {
  test('isStorageServiceName recognizes both firebase.storage and cloud.storage', () => {
    expect(isStorageServiceName('firebase.storage')).toBe(true);
    expect(isStorageServiceName('cloud.storage')).toBe(true);
    expect(isStorageServiceName('cloud.firestore')).toBe(false);
    expect(isStorageServiceName(undefined)).toBe(false);
  });

  test('topLevelMatches returns all top-level match blocks and falls back to single match', () => {
    const multi = parseToAST(`rules_version = '2';
      service cloud.storage {
        match /b/bucket-one/o {
          allow read: if false;
        }
        match /b/bucket-two/o {
          allow read: if false;
        }
      }`)!;
    expect(topLevelMatches(multi.service).map((m) => m.path.raw)).toEqual([
      '/b/bucket-one/o',
      '/b/bucket-two/o',
    ]);

    const singleOnly = { match: multi.service.match };
    expect(topLevelMatches(singleOnly).map((m) => m.path.raw)).toEqual(['/b/bucket-one/o']);
    expect(topLevelMatches(undefined)).toEqual([]);
  });
});
