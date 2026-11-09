import { describe, expect, test } from 'bun:test';
import { resolveModules } from '../../../src/rules/modules/resolver.js';
import {
  evaluateStorageRules,
  parseStorageRules,
  type StorageEvaluationObservation,
} from '../../../src/storage/index.js';

function emptyStorageObservation(): StorageEvaluationObservation {
  return {
    readResource: false,
    readRequestResource: false,
    readFirestore: false,
    readAuthToken: false,
    readAuthTokenEmail: false,
  };
}

describe('evaluateStorageRules observation across helper calls and 2+modules stdlib functions', () => {
  test('preserves all five observation flags across 2+modules helpers and local let bindings', () => {
    const inlineSource = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /items/{id} {',
      '      allow update: if request.auth != null',
      "        && request.auth.token.role == 'editor'",
      "        && request.auth.token.email == 'u1@example.org'",
      '        && resource.metadata.ownerUid == request.auth.uid',
      '        && request.resource.size <= 1024',
      '        && firestore.exists(/databases/(default)/documents/items/$(id));',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const modularSource = [
      "rules_version = '2+modules';",
      "import { hasClaimRole } from 'membership';",
      "import { existingMetadataOwner } from 'storage/metadata';",
      "import { sizeAtMost } from 'storage/uploads';",
      "import { matchesDocument } from 'storage/objects';",
      'service firebase.storage {',
      '  function hasExpectedEmail() {',
      '    let req = request;',
      '    let tok = req.auth.token;',
      "    return tok.email == 'u1@example.org';",
      '  }',
      '  match /b/{bucket}/o {',
      '    match /items/{id} {',
      "      allow update: if hasClaimRole('role', 'editor')",
      '        && hasExpectedEmail()',
      "        && existingMetadataOwner('ownerUid')",
      '        && sizeAtMost(1024)',
      "        && matchesDocument(/databases/(default)/documents/items/$(id), 'objectPath');",
      '    }',
      '  }',
      '}',
    ].join('\n');

    const resolved = resolveModules(modularSource);
    expect(resolved.success).toBe(true);
    if (!resolved.success) return;

    const updateInput = {
      request: {
        auth: { uid: 'u1', token: { role: 'editor', email: 'u1@example.org' } },
        method: 'update' as const,
        path: 'b/my-bucket/o/items/item-1',
        resource: {
          name: 'items/item-1',
          bucket: 'my-bucket',
          size: 64,
          contentType: 'text/plain',
          metadata: { ownerUid: 'u1' },
        },
      },
      resource: {
        name: 'items/item-1',
        bucket: 'my-bucket',
        size: 64,
        contentType: 'text/plain',
        metadata: { ownerUid: 'u1' },
      },
    };
    const firestoreLookup = {
      get: (docPath: string) => (docPath === 'items/item-1' ? { objectPath: 'items/item-1' } : null),
      exists: (docPath: string) => docPath === 'items/item-1',
    };
    const now = new Date('2026-01-01T00:00:00Z');

    const inlineObs = emptyStorageObservation();
    const inlineEval = evaluateStorageRules(
      parseStorageRules(inlineSource),
      updateInput,
      now,
      firestoreLookup,
      inlineObs,
    );
    expect(inlineEval.allowed).toBe(true);

    const modularObs = emptyStorageObservation();
    const modularEval = evaluateStorageRules(
      parseStorageRules(resolved.data.resolved),
      updateInput,
      now,
      firestoreLookup,
      modularObs,
    );
    expect(modularEval.allowed).toBe(true);
    expect({ ...modularObs, matchedRule: modularObs.matchedRule?.path }).toEqual({
      ...inlineObs,
      matchedRule: inlineObs.matchedRule?.path,
    });
    expect(modularObs.readAuthToken).toBe(true);
    expect(modularObs.readAuthTokenEmail).toBe(true);
    expect(modularObs.readResource).toBe(true);
    expect(modularObs.readRequestResource).toBe(true);
    expect(modularObs.readFirestore).toBe(true);

    const letAliasSource = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  function ownsStored(uid) {',
      '    let res = resource;',
      '    return res.metadata.ownerUid == uid;',
      '  }',
      '  match /b/{bucket}/o {',
      '    match /items/{id} {',
      '      allow get: if ownsStored(request.auth.uid);',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const letObs = emptyStorageObservation();
    const letEval = evaluateStorageRules(
      parseStorageRules(letAliasSource),
      {
        request: { auth: { uid: 'u1', token: {} }, method: 'get', path: 'b/my-bucket/o/items/item-1' },
        resource: {
          name: 'items/item-1',
          bucket: 'my-bucket',
          size: 64,
          contentType: 'text/plain',
          metadata: { ownerUid: 'u1' },
        },
      },
      now,
      undefined,
      letObs,
    );
    expect(letEval.allowed).toBe(true);
    expect(letObs.readResource).toBe(true);
  });
});
