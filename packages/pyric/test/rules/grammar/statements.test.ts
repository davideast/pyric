import { describe, test, expect } from 'bun:test';
import { parseRulesFile } from '../../../src/rules/grammar/FirestoreParser.js';

// Wrap a statement in minimal valid file structure for testing
function wrapInFile(body: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    ${body}
  }
}`;
}

function wrapInMatch(stmts: string): string {
  return wrapInFile(`match /items/{itemId} {\n      ${stmts}\n    }`);
}

function valid(input: string) {
  const result = parseRulesFile(input);
  if (!result.valid) console.log('  FAIL:', (result.errors[0] as any)?.message?.substring(0, 150));
  expect(result.valid).toBe(true);
}

function invalid(input: string) {
  const result = parseRulesFile(input);
  expect(result.valid).toBe(false);
}

describe('Firestore Statements', () => {
  // --- Allow statements ---
  describe('allow statements', () => {
    test('allow read', () => valid(wrapInMatch('allow read: if true;')));
    test('allow write', () => valid(wrapInMatch('allow write: if false;')));
    test('allow get', () => valid(wrapInMatch('allow get: if request.auth != null;')));
    test('allow list', () => valid(wrapInMatch('allow list: if request.auth != null;')));
    test('allow create', () => valid(wrapInMatch('allow create: if request.auth != null;')));
    test('allow update', () => valid(wrapInMatch('allow update: if resource.data.owner == request.auth.uid;')));
    test('allow delete', () => valid(wrapInMatch('allow delete: if request.auth != null;')));

    test('combined read, write', () => valid(wrapInMatch('allow read, write: if true;')));
    test('combined create, update', () => valid(wrapInMatch('allow create, update: if request.auth != null;')));
    test('combined get, list', () => valid(wrapInMatch('allow get, list: if true;')));

    test('multiline condition', () => valid(wrapInMatch(`
      allow create: if request.auth != null
                    && request.resource.data.title is string
                    && request.resource.data.title.size() > 0;
    `)));

    test('multiple allows in one match', () => valid(wrapInMatch(`
      allow read: if true;
      allow create: if request.auth != null;
      allow update: if resource.data.owner == request.auth.uid;
      allow delete: if request.auth != null;
    `)));
  });

  // --- Function definitions ---
  describe('function definitions', () => {
    test('no params', () => valid(wrapInFile(`
      function isAuthenticated() {
        return request.auth != null;
      }
      match /items/{itemId} {
        allow read: if isAuthenticated();
      }
    `)));

    test('one param', () => valid(wrapInFile(`
      function isOwner(userId) {
        return request.auth.uid == userId;
      }
      match /items/{itemId} {
        allow read: if isOwner(itemId);
      }
    `)));

    test('multiple params', () => valid(wrapInFile(`
      function hasRole(uid, role) {
        return get(/databases/$(database)/documents/users/$(uid)).data.role == role;
      }
      match /items/{itemId} {
        allow read: if hasRole(request.auth.uid, 'admin');
      }
    `)));

    test('function calling function', () => valid(wrapInFile(`
      function isAuthenticated() {
        return request.auth != null;
      }
      function isOwner(uid) {
        return isAuthenticated() && request.auth.uid == uid;
      }
      match /items/{itemId} {
        allow read: if isOwner(itemId);
      }
    `)));

    test('function scoped inside match', () => valid(wrapInFile(`
      match /items/{itemId} {
        function canRead() {
          return request.auth != null;
        }
        allow read: if canRead();
      }
    `)));

    test('let binding in function body', () => valid(wrapInFile(`
      function isAdmin() {
        let userDoc = get(/databases/$(database)/documents/users/$(request.auth.uid));
        return userDoc.data.role == 'admin';
      }
      match /items/{itemId} {
        allow write: if isAdmin();
      }
    `)));

    test('multiple let bindings', () => valid(wrapInFile(`
      function canModerate(postId) {
        let post = get(/databases/$(database)/documents/posts/$(postId));
        let user = get(/databases/$(database)/documents/users/$(request.auth.uid));
        return user.data.role == 'admin' || post.data.author == request.auth.uid;
      }
      match /items/{itemId} {
        allow write: if canModerate(itemId);
      }
    `)));
  });

  // --- Invalid statements ---
  describe('invalid statements', () => {
    test('invalid operation name', () => invalid(wrapInMatch('allow readwrite: if true;')));

    test('missing colon', () => invalid(wrapInMatch('allow read if true;')));

    test('missing semicolon', () => invalid(wrapInMatch('allow read: if true')));

    test('missing if keyword', () => invalid(wrapInMatch('allow read: true;')));

    test('empty condition', () => invalid(wrapInMatch('allow read: if ;')));
  });
});
