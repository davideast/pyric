import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firestoreRules } from '../../../src/rules/index.js';
import { resolveModules } from '@pyric/rules/internal/node';
import { evaluateStorageRules, parseStorageRules } from '../../../src/storage/index.js';

describe('2+modules export scoping, .rules diamond canonicalization, and commented module headers', () => {
  test('unimported sibling export does not collide with local helper in a match block', () => {
    const shared = [
      'export function baseGuard() { return request.auth != null; }',
      'export function ownsItem(uid) { return baseGuard() && request.auth.uid == uid; }',
    ].join('\n');

    const root = [
      "rules_version = '2+modules';",
      "import { ownsItem } from './shared.rules';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /users/{uid} {',
      '      allow get: if ownsItem(uid);',
      '    }',
      '    match /items/{id} {',
      '      function baseGuard() { return true; }',
      '      allow get: if baseGuard();',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const res = resolveModules(root, { modules: { './shared.rules': shared } });
    expect(res.success).toBe(true);
    if (!res.success) return;

    const compiled = parseStorageRules(res.data.resolved);
    const now = new Date('2026-01-01T00:00:00.000Z');
    // Unauthenticated user denied on /users/u1 (uses module's baseGuard requiring auth), allowed on /items/i1 (uses match-local baseGuard returning true)
    expect(
      evaluateStorageRules(
        compiled,
        { request: { auth: null, method: 'get', path: 'b/my-bucket/o/users/u1' }, resource: null },
        now,
      ).allowed,
    ).toBe(false);
    expect(
      evaluateStorageRules(
        compiled,
        { request: { auth: { uid: 'u1', token: {} }, method: 'get', path: 'b/my-bucket/o/users/u1' }, resource: null },
        now,
      ).allowed,
    ).toBe(true);
    expect(
      evaluateStorageRules(
        compiled,
        { request: { auth: null, method: 'get', path: 'b/my-bucket/o/items/i1' }, resource: null },
        now,
      ).allowed,
    ).toBe(true);
  });

  test('transitive stdlib export does not collide with local helper in a match block', () => {
    const root = [
      "rules_version = '2+modules';",
      "import { resignedBy } from 'results';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /docs/{docId} {',
      '      allow update: if resignedBy(request.auth.uid);',
      '    }',
      '    match /items/{id} {',
      '      function statusIs(expected) {',
      '        return resource.data.state == expected;',
      '      }',
      "      allow get: if statusIs('active');",
      '    }',
      '  }',
      '}',
    ].join('\n');

    const res = resolveModules(root);
    expect(res.success).toBe(true);
    if (!res.success) return;

    const sim = firestoreRules(res.data.resolved).simulate([
      {
        description: 'match-local statusIs allows active item',
        expectation: 'ALLOW',
        method: 'get',
        path: 'items/i1',
        auth: null,
        resource: { state: 'active' },
      },
      {
        description: 'match-local statusIs denies archived item',
        expectation: 'DENY',
        method: 'get',
        path: 'items/i1',
        auth: null,
        resource: { state: 'archived' },
      },
    ]);
    expect(sim.failed).toBe(0);
    expect(sim.passed).toBe(2);
  });

  test('diamond relative imports mixing ./shared and ./shared.rules canonicalize to one module on disk and in modules map', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rules-mod-diamond-'));
    try {
      const sharedContent = 'export function baseGuard() { return request.auth != null; }\n';
      const branchContent = "import { baseGuard } from './shared';\nexport function guardA() { return baseGuard(); }\n";
      const rootContent = [
        "rules_version = '2+modules';",
        "import { baseGuard } from './shared.rules';",
        "import { guardA } from './branch-a.rules';",
        'service firebase.storage {',
        '  match /b/{bucket}/o {',
        '    match /items/{id} {',
        '      allow read: if baseGuard() && guardA();',
        '    }',
        '  }',
        '}',
      ].join('\n');

      writeFileSync(join(dir, 'shared.rules'), sharedContent);
      writeFileSync(join(dir, 'branch-a.rules'), branchContent);

      const diskRes = resolveModules(rootContent, { basePath: dir });
      expect(diskRes.success).toBe(true);
      if (diskRes.success) {
        expect(diskRes.data.resolved.match(/function baseGuard\(/g)).toHaveLength(1);
      }

      const mapRes = resolveModules(rootContent, {
        modules: {
          './shared.rules': sharedContent,
          './branch-a.rules': branchContent,
        },
      });
      expect(mapRes.success).toBe(true);
      if (mapRes.success) {
        expect(mapRes.data.resolved.match(/function baseGuard\(/g)).toHaveLength(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('accepts block and line comments inside module rules_version and import declarations', () => {
    const sharedContent = [
      'export function baseGuard() { return request.auth != null; }',
      'export function ownsItem(uid) { return request.auth.uid == uid; }',
    ].join('\n');

    const commentedModule = [
      "rules_version /* v-comment */ = '2+modules' /* trailing */ ;",
      'import /* before-brace */ {',
      '  /* comment with } brace inside */ baseGuard /* after-ident */ , // line comment',
      '  ownsItem',
      "} /* before-from */ from /* before-path */ './shared.rules' /* before-semi */ ;",
      'export function guardCommented(uid) { return baseGuard() && ownsItem(uid); }',
    ].join('\n');

    const rootContent = [
      "rules_version = '2+modules';",
      "import { /* root inline comment */ guardCommented } from './commented-mod.rules';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /items/{uid} {',
      '      allow get: if guardCommented(uid);',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const res = resolveModules(rootContent, {
      modules: {
        './shared.rules': sharedContent,
        './commented-mod.rules': commentedModule,
      },
    });
    expect(res.success).toBe(true);
  });
});
