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
