import { describe, expect, test } from 'bun:test';
import { lint } from '../../../src/rules/index.js';
import { resolveModulesBrowser } from '../../../src/rules/modules/resolver-browser.js';

describe('lint() on rules_version = 2+modules stdlib rulesets', () => {
  test('accepts valid 2+modules Storage write rules using bundled stdlib auth and upload validators', () => {
    const validStorageModules = `
rules_version = '2+modules';
import { hasClaimRole } from 'membership';
import { incomingMetadataOwner } from 'storage/metadata';
import { sizeAtMost, contentTypeMatches } from 'storage/uploads';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/{id} {
      allow create: if hasClaimRole('role', 'editor')
        && incomingMetadataOwner('ownerUid')
        && sizeAtMost(4096)
        && contentTypeMatches('image/.*');
    }
  }
}
`;
    const resolved = resolveModulesBrowser(validStorageModules);
    expect(resolved.success).toBe(true);
    if (!resolved.success) return;

    const rawErrors = lint(validStorageModules).filter((i) => i.severity === 'error').map((i) => i.code);
    const resolvedErrors = lint(resolved.data.resolved).filter((i) => i.severity === 'error').map((i) => i.code);
    expect(rawErrors).toEqual([]);
    expect(resolvedErrors).toEqual([]);
  });

  test('accepts valid 2+modules Firestore write rules using bundled stdlib auth and schema validators', () => {
    const validFirestoreModules = `
rules_version = '2+modules';
import { validAuthorCreate } from 'content';
import { hasRequired, validString } from 'validation';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} {
      allow create: if validAuthorCreate('ownerId')
        && hasRequired(['ownerId', 'title'])
        && validString('title', 1, 80);
    }
  }
}
`;
    const resolved = resolveModulesBrowser(validFirestoreModules);
    expect(resolved.success).toBe(true);
    if (!resolved.success) return;

    const rawErrors = lint(validFirestoreModules).filter((i) => i.severity === 'error').map((i) => i.code);
    const resolvedErrors = lint(resolved.data.resolved).filter((i) => i.severity === 'error').map((i) => i.code);
    expect(rawErrors).toEqual([]);
    expect(resolvedErrors).toEqual([]);
  });

  test('catches Storage lookup caps and Firestore expression budget exhaustion across stdlib helpers', () => {
    const overCapStorageModules = `
rules_version = '2+modules';
import { isAuthenticated } from 'auth';
import { sizeAtMost } from 'storage/uploads';
import { matchesDocument } from 'storage/objects';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/{id} {
      allow create: if isAuthenticated()
        && sizeAtMost(1024)
        && matchesDocument(/databases/(default)/documents/docs/a, 'ownerUid')
        && matchesDocument(/databases/(default)/documents/docs/b, 'ownerUid')
        && matchesDocument(/databases/(default)/documents/docs/c, 'ownerUid');
    }
  }
}
`;
    const rawCapCodes = lint(overCapStorageModules).map((i) => i.code);
    expect(rawCapCodes).toContain('SEM-3');
    expect(rawCapCodes).toContain('GET_COUNT');

    const overBudgetFsModules = `
rules_version = '2+modules';
import { digestByte } from 'fairness';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} {
      allow get: if ${Array.from({ length: 18 }, (_, i) => `digestByte(resource.data.d, ${i}) == 0`).join(' && ')};
    }
  }
}
`;
    const rawBudgetCodes = lint(overBudgetFsModules).map((i) => i.code);
    expect(rawBudgetCodes).toContain('EXPRESSION_BUDGET');
  });

  test('does not suppress SEM-4 or SEC-3 for unexported auth helper names', () => {
    for (const name of ['isSignedIn', 'isVerified', 'hasRole', 'hasAnyRole']) {
      const readProbe = `rules_version = '2+modules';
import { ${name} } from 'auth';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} {
      allow read: if ${name}();
    }
  }
}`;
      expect(resolveModulesBrowser(readProbe).success).toBe(false);
      const readCodes = lint(readProbe).filter((i) => i.severity === 'error').map((i) => i.code);
      expect(readCodes).toContain('SEM-4');

      const writeProbe = `rules_version = '2+modules';
import { ${name} } from 'auth';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} {
      allow write: if ${name}() && request.resource.data.ok == true;
    }
  }
}`;
      const writeCodes = lint(writeProbe).filter((i) => i.severity === 'error').map((i) => i.code);
      expect(writeCodes).toContain('SEM-4');
      expect(writeCodes).toContain('SEC-3');
    }
  });
});
