/**
 * ─── Scenario 5: metadata-access ────────────────────────────────────────────────
 * Custom metadata in BOTH dotted (resource.metadata.owner) and bracket
 * (resource.metadata['owner']) form — they must resolve identically — and a
 * missing key (undefined → deny).
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-META',
  rationale:
    'resource.metadata custom-metadata access in dotted and bracket form (identical resolution) and missing-key deny.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /dotted/{fileId} {
      allow get: if resource.metadata.owner == request.auth.uid;
    }
    match /bracket/{fileId} {
      allow get: if resource.metadata['owner'] == request.auth.uid;
    }
    match /bkNe/{fileId} {
      allow get: if resource.metadata['missing'] != 'x';
    }
    match /bkEqNull/{fileId} {
      allow get: if resource.metadata['missing'] == null;
    }
    match /bkNotEq/{fileId} {
      allow get: if !(resource.metadata['missing'] == 'x');
    }
    match /bkOrTrue/{fileId} {
      allow get: if resource.metadata['missing'] == 'x' || true;
    }
    match /reqBkNe/{fileId} {
      allow create: if request.resource.metadata['missing'] != 'x';
    }
    match /reqBkEqNull/{fileId} {
      allow create: if request.resource.metadata['missing'] == null;
    }
  }
}`,
  cases: [
    { description: 'dotted metadata: owner matches → allow', expectation: 'ALLOW', method: 'get', path: 'dotted/a.txt', auth: { uid: 'alice' }, existingResource: { size: 10, metadata: { owner: 'alice' } } },
    { description: 'dotted metadata: owner mismatch → deny', expectation: 'DENY', method: 'get', path: 'dotted/a.txt', auth: { uid: 'bob' }, existingResource: { size: 10, metadata: { owner: 'alice' } } },
    { description: 'dotted metadata: missing owner key → deny', expectation: 'DENY', method: 'get', path: 'dotted/a.txt', auth: { uid: 'alice' }, existingResource: { size: 10, metadata: {} } },
    { description: 'bracket metadata: owner matches → allow', expectation: 'ALLOW', method: 'get', path: 'bracket/b.txt', auth: { uid: 'alice' }, existingResource: { size: 10, metadata: { owner: 'alice' } } },
    { description: 'bracket metadata: owner mismatch → deny', expectation: 'DENY', method: 'get', path: 'bracket/b.txt', auth: { uid: 'bob' }, existingResource: { size: 10, metadata: { owner: 'alice' } } },
    { description: "bracket metadata: missing key != 'x' → deny", expectation: 'DENY', method: 'get', path: 'bkNe/c.txt', auth: { uid: 'alice' }, existingResource: { size: 10, metadata: { owner: 'alice' } } },
    { description: 'bracket metadata: missing key == null → deny', expectation: 'DENY', method: 'get', path: 'bkEqNull/c.txt', auth: { uid: 'alice' }, existingResource: { size: 10, metadata: { owner: 'alice' } } },
    { description: "bracket metadata: !(missing key == 'x') → deny", expectation: 'DENY', method: 'get', path: 'bkNotEq/c.txt', auth: { uid: 'alice' }, existingResource: { size: 10, metadata: { owner: 'alice' } } },
    { description: "bracket metadata: missing key == 'x' || true → allow", expectation: 'ALLOW', method: 'get', path: 'bkOrTrue/c.txt', auth: { uid: 'alice' }, existingResource: { size: 10, metadata: { owner: 'alice' } } },
    { description: "bracket request metadata: missing key != 'x' → deny", expectation: 'DENY', method: 'create', path: 'reqBkNe/c.txt', auth: { uid: 'alice' }, resource: { size: 10, contentType: 'text/plain', metadata: { owner: 'alice' } } },
    { description: 'bracket request metadata: missing key == null → deny', expectation: 'DENY', method: 'create', path: 'reqBkEqNull/c.txt', auth: { uid: 'alice' }, resource: { size: 10, contentType: 'text/plain', metadata: { owner: 'alice' } } },
  ],
};
