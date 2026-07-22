import { describe, it, expect } from 'bun:test';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';

const SESSION_ARCHIVE_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /sessions/{sessionId} {
      allow write: if request.auth != null
                   && (request.method == 'delete'
                       || (request.resource.size < 10 * 1024 * 1024
                           && request.resource.contentType == 'application/json'));
      allow read: if request.auth != null;
    }
  }
}`;

describe('parseStorageRules', () => {
  it('parses the canonical session-archive ruleset', () => {
    const rules = parseStorageRules(SESSION_ARCHIVE_RULES);
    expect(rules).toBeDefined();
  });

  it('rejects unknown service header', () => {
    expect(() =>
      parseStorageRules(`service cloud.firestore { match /x { allow read: if true; } }`),
    ).toThrow();
  });

  it('parses the granular verbs (get/list/create/update/delete)', () => {
    expect(() =>
      parseStorageRules(`service firebase.storage {
        match /b/{bucket}/o {
          match /x/{id} { allow get, list, create, update, delete: if true; }
        }
      }`),
    ).not.toThrow();
  });

  it('rejects verbs outside the storage grammar', () => {
    expect(() =>
      parseStorageRules(`service firebase.storage {
        match /b/{bucket}/o {
          match /x/{id} { allow query: if true; }
        }
      }`),
    ).toThrow(/expected "delete", "update", "create", "list", "get", "write", or "read"/);
  });

  it('rejects unterminated strings', () => {
    expect(() =>
      parseStorageRules(`service firebase.storage {
        match /b/{bucket}/o {
          match /x { allow read: if 'unterminated; }
        }
      }`),
    ).toThrow();
  });
});
