import { describe, expect, test } from 'bun:test';
import { createStorageRulesResolution } from '../../src/storage/rules-resolution.js';
import { parseStorageRules } from '../../src/storage/sandbox/rules.js';

function resolutionFor(source: string, modules: readonly string[] = []) {
  return createStorageRulesResolution(source, modules, parseStorageRules(source));
}

describe('Storage rules resolution evidence', () => {
  test('classifies modules and parsed Firestore lookups independent of formatting', () => {
    const source = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{file} {
      allow read: if firestore
        .get(/databases/(default)/documents/members/$(request.auth.uid)).data.active;
    }
  }
}`;
    const resolution = resolutionFor(source, ['auth', 'storage/uploads']);

    expect(resolution.evidenceIds).toEqual([
      'storage-rules#125',
      'storage-rules#131',
      'storage-rules#132',
    ]);
    expect(Object.isFrozen(resolution)).toBe(true);
    expect(Object.isFrozen(resolution.modules)).toBe(true);
  });

  test('does not infer lookup evidence from comments or strings', () => {
    const source = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    // firestore.get(...) is documentation, not an executed lookup.
    match /{file} { allow read: if 'firestore.exists(' == 'not a call'; }
  }
}`;

    expect(resolutionFor(source).evidenceIds).toEqual([]);
  });
});
