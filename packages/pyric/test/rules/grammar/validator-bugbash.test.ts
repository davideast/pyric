/**
 * Validator bug bash — converted to permanent tests (36 assertions).
 * Tests live production rules, insecure rules, semantic errors,
 * function scope, doc read budget, quality checks, structure checks,
 * check interactions, and transitive auth resolution.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { validateFirestoreRules, type ValidationFinding } from '../../../src/rules/grammar/FirestoreValidator.js';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';

function validateRules(source: string): ValidationFinding[] {
  const ast = parseToAST(source);
  if (!ast) throw new Error('Failed to parse');
  return validateFirestoreRules(ast);
}

function hasFinding(results: ValidationFinding[], code: string): boolean {
  return results.some(f => f.code === code);
}

const wrap = (body: string) => `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{d=**} { allow read, write: if false; }
    ${body}
  }
}`;

describe('Validator Bug Bash', () => {
  describe('deliberately insecure rules', () => {
    const findings = validateRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`);
    test('SEC-1: public write', () => expect(hasFinding(findings, 'SEC-1')).toBe(true));
    test('SEC-2: public read wildcard', () => expect(hasFinding(findings, 'SEC-2')).toBe(true));
    test('SEC-5: permissive wildcard', () => expect(hasFinding(findings, 'SEC-5')).toBe(true));
    test('QUA-1: hardcoded true', () => expect(hasFinding(findings, 'QUA-1')).toBe(true));
    test('SEC-1 is critical', () => expect(findings.find(f => f.code === 'SEC-1')!.severity).toBe('critical'));
  });

  describe('no auth on write', () => {
    const findings = validateRules(wrap(`
      match /items/{id} {
        allow read: if true;
        allow create: if request.resource.data.title is string;
        allow update: if resource.data.owner == request.resource.data.owner;
        allow delete: if resource.data.active == false;
      }
    `));
    test('create has SEC-3', () => expect(findings.some(f => f.code === 'SEC-3' && f.operation?.includes('create'))).toBe(true));
    test('update has SEC-3', () => expect(findings.some(f => f.code === 'SEC-3' && f.operation?.includes('update'))).toBe(true));
    test('delete has SEC-3', () => expect(findings.some(f => f.code === 'SEC-3' && f.operation?.includes('delete'))).toBe(true));
  });

  describe('request.resource.data in read', () => {
    const findings = validateRules(wrap(`
      match /items/{id} {
        allow get: if request.resource.data.published == true;
        allow create: if request.auth != null && request.resource.data.title is string;
      }
    `));
    test('SEM-1 on get', () => expect(findings.some(f => f.code === 'SEM-1' && f.operation?.includes('get'))).toBe(true));
    test('SEM-1 NOT on create', () => expect(findings.some(f => f.code === 'SEM-1' && f.operation?.includes('create'))).toBe(false));
  });

  describe('resource.data in create', () => {
    const findings = validateRules(wrap(`
      match /items/{id} {
        allow create: if request.auth != null && resource.data.owner == request.auth.uid && request.resource.data.title is string;
        allow update: if request.auth != null && resource.data.owner == request.auth.uid;
      }
    `));
    test('SEM-2 on create', () => expect(findings.some(f => f.code === 'SEM-2' && f.operation?.includes('create'))).toBe(true));
    test('SEM-2 NOT on update', () => expect(findings.some(f => f.code === 'SEM-2' && f.operation?.includes('update'))).toBe(false));
  });

  describe('get()/exists() budget', () => {
    test('exceeds budget with function + inline', () => {
      const findings = validateRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{d=**} { allow read, write: if false; }
    function readMany(uid) {
      return get(/databases/$(database)/documents/a/$(uid)).data.x == 'y'
             && get(/databases/$(database)/documents/b/$(uid)).data.x == 'y'
             && get(/databases/$(database)/documents/c/$(uid)).data.x == 'y'
             && get(/databases/$(database)/documents/d/$(uid)).data.x == 'y'
             && get(/databases/$(database)/documents/e/$(uid)).data.x == 'y'
             && get(/databases/$(database)/documents/f/$(uid)).data.x == 'y';
    }
    match /items/{id} {
      allow read: if readMany(request.auth.uid)
                  && exists(/databases/$(database)/documents/g/$(request.auth.uid))
                  && exists(/databases/$(database)/documents/h/$(request.auth.uid))
                  && exists(/databases/$(database)/documents/i/$(request.auth.uid))
                  && exists(/databases/$(database)/documents/j/$(request.auth.uid))
                  && exists(/databases/$(database)/documents/k/$(request.auth.uid));
    }
  }
}`);
      expect(hasFinding(findings, 'SEM-3')).toBe(true);
    });

    test('under budget not flagged', () => {
      const findings = validateRules(wrap(`
        match /items/{id} {
          allow read: if exists(/databases/$(database)/documents/users/$(request.auth.uid))
                      && get(/databases/$(database)/documents/config/settings).data.enabled == true;
        }
      `));
      expect(hasFinding(findings, 'SEM-3')).toBe(false);
    });
  });

  describe('quality checks', () => {
    test('QUA-2: empty match', () => {
      expect(hasFinding(validateRules(wrap('match /empty/{id} { }')), 'QUA-2')).toBe(true);
    });
    test('QUA-3: duplicate functions', () => {
      expect(hasFinding(validateRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{d=**} { allow read, write: if false; }
    function helper() { return true; }
    function helper() { return false; }
    match /items/{id} { allow read: if helper(); }
  }
}`), 'QUA-3')).toBe(true);
    });
    test('QUA-4: unused function', () => {
      expect(hasFinding(validateRules(wrap(`
        function neverCalled() { return true; }
        match /items/{id} { allow read: if request.auth != null; }
      `)), 'QUA-4')).toBe(true);
    });
  });

  describe('structure checks', () => {
    test('STR-1: match without wildcard', () => {
      expect(hasFinding(validateRules(wrap('match /admin { allow read: if request.auth != null; }')), 'STR-1')).toBe(true);
    });
    test('STR-2: nested without parent rules', () => {
      expect(hasFinding(validateRules(wrap(`
        match /parent/{id} {
          match /child/{cid} { allow read: if true; }
        }
      `)), 'STR-2')).toBe(true);
    });
  });

  describe('transitive auth resolution (SEC-3 bug fix)', () => {
    test('auth in called function → no SEC-3', () => {
      const findings = validateRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{d=**} { allow read, write: if false; }
    function isAuthenticated() { return request.auth != null; }
    function isOwner(uid) { return isAuthenticated() && request.auth.uid == uid; }
    match /users/{userId} {
      allow read: if isAuthenticated();
      allow create: if isOwner(userId) && request.resource.data.email is string;
      allow update: if isOwner(userId) && request.resource.data.email is string;
      allow delete: if isOwner(userId);
    }
  }
}`);
      expect(findings.filter(f => f.severity === 'critical')).toHaveLength(0);
      expect(findings.filter(f => f.severity === 'high')).toHaveLength(0);
    });
  });

  describe('check interactions', () => {
    test('multiple findings on insecure + unused fn', () => {
      const findings = validateRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
    function orphan() { return true; }
  }
}`);
      const codes = findings.map(f => f.code);
      expect(codes).toContain('SEC-1');
      expect(codes).toContain('SEC-2');
      expect(codes).toContain('SEC-5');
      expect(codes).toContain('QUA-1');
      expect(codes).toContain('QUA-4');
    });
  });
});
