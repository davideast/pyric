import { describe, expect, test } from 'bun:test';
import { parseImportedSymbols, computeCriticalSymbols } from './entry-path-symbols.ts';

describe('parseImportedSymbols', () => {
  test('extracts named imports from a tracked pyric/* specifier', () => {
    const source = `import { getAuth, onAuthStateChanged } from 'pyric/auth';\n`;
    const result = parseImportedSymbols(source);
    expect([...(result.get('pyric/auth') ?? [])].sort()).toEqual(['getAuth', 'onAuthStateChanged']);
  });

  test('ignores whole-statement type-only imports', () => {
    const source = `import type { Auth } from 'pyric/auth';\n`;
    const result = parseImportedSymbols(source);
    expect(result.has('pyric/auth')).toBe(false);
  });

  test('drops a per-specifier `type X` inside a mixed import, keeps runtime siblings', () => {
    const source = `import { type Auth, getAuth } from 'pyric/auth';\n`;
    const result = parseImportedSymbols(source);
    expect([...(result.get('pyric/auth') ?? [])]).toEqual(['getAuth']);
  });

  test('resolves an aliased import back to its real exported name', () => {
    const source = `import { getAuth as getAuthAlias } from 'pyric/auth';\n`;
    const result = parseImportedSymbols(source);
    expect([...(result.get('pyric/auth') ?? [])]).toEqual(['getAuth']);
  });

  test('ignores non-pyric import specifiers entirely', () => {
    const source = `import { initializeApp } from 'firebase/app';\nimport 'fake-indexeddb/auto';\n`;
    const result = parseImportedSymbols(source);
    expect(result.size).toBe(0);
  });

  test('parses a multi-line named-import list as one statement', () => {
    const source = `import {\n  getAuth,\n  onAuthStateChanged,\n  setPersistence,\n} from 'pyric/auth';\n`;
    const result = parseImportedSymbols(source);
    expect([...(result.get('pyric/auth') ?? [])].sort()).toEqual(['getAuth', 'onAuthStateChanged', 'setPersistence']);
  });
});

describe('computeCriticalSymbols (real entry-path corpus)', () => {
  test('every tracked program contributes pyric/app + pyric/sandbox critical symbols', () => {
    const report = computeCriticalSymbols();
    expect(report.packages['pyric/app']?.symbols).toContain('initializeApp');
    expect(report.packages['pyric/sandbox']?.symbols).toContain('initializeSandbox');
  });
});
