import { describe, expect, test } from 'bun:test';
import { firestoreRules } from '../../../src/rules/index.js';
import { resolveModules } from '../../../src/rules/modules/resolver.js';
import { evaluateStorageRules, parseStorageRules } from '../../../src/storage/index.js';

describe('2+modules distinct module path private helper isolation', () => {
  test('isolates private helpers with identical local names across ./auth/helpers, ./auth_helpers, and ./auth-helpers in Firestore and Storage', () => {
    const modules = {
      './auth/helpers': [
        'function check() { return request.auth != null; }',
        'export function canRead() { return check(); }',
      ].join('\n'),
      './auth_helpers': [
        'function check() { return request.auth != null && request.auth.uid == "u1"; }',
        'export function canCreate() { return check(); }',
      ].join('\n'),
      './auth-helpers': [
        'function check() { return request.auth != null && request.auth.uid == "admin"; }',
        'export function canDelete() { return check(); }',
      ].join('\n'),
    };

    const firestoreSource = [
      "rules_version = '2+modules';",
      "import { canRead } from './auth/helpers';",
      "import { canCreate } from './auth_helpers';",
      "import { canDelete } from './auth-helpers';",
      'service cloud.firestore {',
      '  match /databases/{db}/documents {',
      '    match /items/{id} {',
      '      allow get: if canRead();',
      '      allow create: if canCreate();',
      '      allow delete: if canDelete();',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const fsResolved = resolveModules(firestoreSource, { modules });
    expect(fsResolved.success).toBe(true);
    if (!fsResolved.success) return;

    const fsSim = firestoreRules(fsResolved.data.resolved).simulate([
      { description: 'get allowed', expectation: 'ALLOW', method: 'get', path: 'items/a', auth: { uid: 'u2' } },
      { description: 'create denied for u2', expectation: 'DENY', method: 'create', path: 'items/a', auth: { uid: 'u2' }, data: { ok: true } },
      { description: 'create allowed for u1', expectation: 'ALLOW', method: 'create', path: 'items/a', auth: { uid: 'u1' }, data: { ok: true } },
      { description: 'delete denied for u1', expectation: 'DENY', method: 'delete', path: 'items/a', auth: { uid: 'u1' } },
      { description: 'delete allowed for admin', expectation: 'ALLOW', method: 'delete', path: 'items/a', auth: { uid: 'admin' } },
    ]);
    expect(fsSim.failed).toBe(0);
    expect(fsSim.passed).toBe(5);

    const storageSource = [
      "rules_version = '2+modules';",
      "import { canRead } from './auth/helpers';",
      "import { canCreate } from './auth_helpers';",
      "import { canDelete } from './auth-helpers';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /items/{id} {',
      '      allow get: if canRead();',
      '      allow create: if canCreate();',
      '      allow delete: if canDelete();',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const stResolved = resolveModules(storageSource, { modules });
    expect(stResolved.success).toBe(true);
    if (!stResolved.success) return;

    const compiledStorage = parseStorageRules(stResolved.data.resolved);
    const now = new Date('2026-01-01T00:00:00.000Z');
    const evalSt = (method: 'get' | 'create' | 'delete', uid: string) =>
      evaluateStorageRules(
        compiledStorage,
        {
          request: {
            auth: { uid, token: {} },
            method,
            path: 'b/default-bucket/o/items/a',
          },
          resource: null,
        },
        now,
      ).allowed;

    expect(evalSt('get', 'u2')).toBe(true);
    expect(evalSt('create', 'u2')).toBe(false);
    expect(evalSt('create', 'u1')).toBe(true);
    expect(evalSt('delete', 'u1')).toBe(false);
    expect(evalSt('delete', 'admin')).toBe(true);
  });
});
