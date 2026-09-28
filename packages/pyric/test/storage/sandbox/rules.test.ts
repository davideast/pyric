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

  it('names the statement an unterminated allow belongs to', () => {
    expect(() =>
      parseStorageRules(`service firebase.storage {
  match /b/{bucket}/o {
    match /x/{id} {
      allow read: if true
    }
  }
}`),
    ).toThrow(
      "Storage rules parse error at line 5, column 5: expected ';' after the allow statement.",
    );
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

  // Production rejects a second definition of one function name in the same
  // scope at compile time with `Function f is already defined.`. A nested
  // match block that redefines an outer name shadows it and compiles.
  it.each([
    ['one match block', `match /b/{bucket}/o {
    function f() { return true; }
    function f() { return false; }
    match /c/{id} { allow read: if f(); }
  }`],
    ['service scope', `function f() { return true; }
  function f() { return false; }
  match /b/{bucket}/o {
    match /c/{id} { allow read: if f(); }
  }`],
  ])('rejects two functions of one name in %s', (_scope, body) => {
    expect(() => parseStorageRules(`rules_version = '2';
service firebase.storage {
  ${body}
}`)).toThrow('Function f is already defined.');
  });

  it('accepts a nested match block function that shadows an outer one', () => {
    expect(() => parseStorageRules(`rules_version = '2';
service firebase.storage {
  function f() { return true; }
  match /b/{bucket}/o {
    function f() { return false; }
    match /c/{id} { allow read: if f(); }
  }
}`)).not.toThrow();
  });
});
