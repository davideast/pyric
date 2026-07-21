import { describe, expect, test } from 'bun:test';
import { resolveModulesWith } from '../../../src/rules/modules/resolver-core.js';

const MODULES = {
  './mixed': `
    export function portable(value) {
      return value.x == 1;
    }
    export function firestoreCaller() {
      return portable(resource.data);
    }
  `,
};

function storageSource(imports: string, condition: string): string {
  return `rules_version = '2+modules';
${imports}
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} { allow read: if ${condition}; }
  }
}`;
}

describe('resolver core export isolation', () => {
  test.each([
    [
      'private-prefix collision',
      `function helper() { return false; }
       export function m__helper() { return true; }
       export function policy() { return helper(); }`,
    ],
    [
      'duplicate exports',
      `export function policy() { return false; }
       export function policy() { return true; }`,
    ],
    [
      'private/export duplicate original name',
      `function policy() { return false; }
       export function policy() { return true; }`,
    ],
  ])('rejects ambiguous same-module names: %s', (_name, moduleSource) => {
    const result = resolveModulesWith(null, storageSource(
      "import { policy } from './m';",
      'policy()',
    ), { modules: { './m': moduleSource } });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('DUPLICATE_FUNCTION');
  });

  test('rejects module functions that collide with Rules builtins', () => {
    const result = resolveModulesWith(null, `rules_version = '2+modules';
import { policy } from './policy';
service cloud.firestore {
  match /databases/{database}/documents/{doc=**} {
    allow read: if policy();
  }
}`, { modules: { './policy': `
      export function debug(value) { return false; }
      export function policy() { return debug(true); }
    ` } });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('DUPLICATE_FUNCTION');
  });

  test('rejects source functions that can capture module builtin calls', () => {
    const result = resolveModulesWith(null, `rules_version = '2+modules';
import { policy } from './policy';
service cloud.firestore {
  function get(path) { return null; }
  match /databases/{database}/documents/{doc=**} {
    allow read: if policy();
  }
}`, { modules: { './policy': `
      export function policy() {
        return get(/databases/(default)/documents/users/alice) != null;
      }
    ` } });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('DUPLICATE_FUNCTION');
  });

  test('rejects empty imports', () => {
    const result = resolveModulesWith(null, storageSource(
      "import { } from './policy';",
      'false',
    ), { modules: { './policy': 'export function policy() { return true; }' } });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('UNKNOWN_FUNCTION');
  });

  test('does not bind undeclared calls across module ownership boundaries', () => {
    const result = resolveModulesWith(null, storageSource(
      "import { policy } from './a';\nimport { unrelated } from './b';",
      'policy()',
    ), { modules: {
      './a': 'export function policy() { return helper(); }',
      './b': `export function helper() { return true; }
              export function unrelated() { return true; }`,
    } });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('UNKNOWN_FUNCTION');
  });

  test('injects imports at service scope so service helpers can call them', () => {
    const result = resolveModulesWith(null, `rules_version = '2+modules';
import { policy } from './policy';
service firebase.storage {
  function gate() { return policy(); }
  match /b/{bucket}/o { match /{file} { allow read: if gate(); } }
}`, { modules: { './policy': 'export function policy() { return true; }' } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resolved.indexOf('function policy()'))
        .toBeLessThan(result.data.resolved.indexOf('function gate()'));
    }
  });

  test('rejects global helpers that call service-scoped imports', () => {
    const result = resolveModulesWith(null, `rules_version = '2+modules';
import { policy } from './policy';
function gate() { return policy(); }
service firebase.storage {
  match /b/{bucket}/o { match /{file} { allow read: if gate(); } }
}`, { modules: { './policy': 'export function policy() { return true; }' } });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INCOMPATIBLE_FUNCTION');
  });

  test('rejects global helpers that reach imports through service helpers', () => {
    const result = resolveModulesWith(null, `rules_version = '2+modules';
import { policy } from './policy';
function globalGate() { return serviceGate(); }
service firebase.storage {
  function serviceGate() { return policy(); }
  match /b/{bucket}/o { match /{file} { allow read: if globalGate(); } }
}`, { modules: { './policy': 'export function policy() { return true; }' } });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INCOMPATIBLE_FUNCTION');
  });

  test('preserves valid service helpers that call global helpers', () => {
    const result = resolveModulesWith(null, `rules_version = '2+modules';
import { policy } from './policy';
function globalGate() { return true; }
service firebase.storage {
  function serviceGate() { return globalGate() && policy(); }
  match /b/{bucket}/o { match /{file} { allow read: if serviceGate(); } }
}`, { modules: { './policy': 'export function policy() { return true; }' } });
    expect(result.success).toBe(true);
  });

  test('rejects imported function collisions in every source scope', () => {
    const declarations = {
      global: `function policy() { return true; }
service firebase.storage {
  match /b/{bucket}/o { match /{file} { allow read: if policy(); } }
}`,
      service: `service firebase.storage {
  function policy() { return true; }
  match /b/{bucket}/o { match /{file} { allow read: if policy(); } }
}`,
      rootMatch: `service firebase.storage {
  match /b/{bucket}/o {
    function policy() { return true; }
    match /{file} { allow read: if policy(); }
  }
}`,
      descendantMatch: `service firebase.storage {
  match /b/{bucket}/o {
    match /{file} {
      function policy() { return true; }
      allow read: if policy();
    }
  }
}`,
    };
    for (const [scope, declaration] of Object.entries(declarations)) {
      const result = resolveModulesWith(null, `rules_version = '2+modules';
import { policy } from './policy';
${declaration}`, { modules: {
        './policy': 'export function policy() { return false; }',
      } });
      expect(result.success, scope).toBe(false);
      if (!result.success) expect(result.error.code).toBe('DUPLICATE_FUNCTION');
    }
  });

  test('ignores incompatible call sites in unrequested exports', () => {
    const result = resolveModulesWith(
      null,
      storageSource("import { portable } from './mixed';", "portable({'x': 1})"),
      { modules: MODULES },
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resolved).toContain('function portable');
      expect(result.data.resolved).not.toContain('firestoreCaller');
    }
  });

  test.each([
    ["import { firestoreCaller } from './mixed';", 'incompatible export alone'],
    ["import { portable, firestoreCaller } from './mixed';", 'both exports'],
  ])('rejects incompatible reachable call sites: %s (%s)', (imports) => {
    const result = resolveModulesWith(
      null,
      storageSource(imports, 'firestoreCaller()'),
      { modules: MODULES },
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INCOMPATIBLE_FUNCTION');
      expect(result.error.message).toContain("binding 'resource.data");
    }
  });
});
