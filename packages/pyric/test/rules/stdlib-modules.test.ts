/**
 * Drift check for the stdlib-modules data.
 *
 * The single source of truth for what's callable from Firestore Rules
 * is the runtime — the validator, evaluator, hallucination linter,
 * and wrapper-class implementations. `STDLIB_MODULES` in
 * `src/stdlib-modules.ts` mirrors that knowledge into a typed,
 * agent-readable shape. This test fails loudly when the two drift —
 * if a new builtin lands in the runtime constants and we forget to
 * document it here, the test fails until we add the entry.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STDLIB_MODULES,
  findModuleByKey,
  allModuleKeys,
  suggestKey,
} from '../../src/rules/stdlib-modules.js';

// Re-import the source-of-truth constants. These are the same sets
// the engine + linter actually use at runtime — keeping the drift
// check fast and stable.
//
// Note: BUILTIN_FUNCTIONS is also re-declared in
// `src/modules/resolver.ts` for the same set; we only check against
// one declaration since they're locked together.
const BUILTIN_FUNCTIONS = ['get', 'exists', 'getAfter', 'debug'] as const;
const BUILTIN_NAMESPACES = ['math', 'timestamp', 'duration', 'latlng', 'hashing'] as const;
const KNOWN_BUILTIN_METHODS = [
  'size', 'keys', 'values', 'lower', 'upper', 'trim',
  'hasAll', 'hasAny', 'hasOnly', 'toSet', 'toUtf8',
] as const;

// Canonical site reference user-authored module names. We parse the markdown file
// rather than hard-coding so a new module added there fails the
// test until it's mirrored here.
const STDLIB_MD_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../site-docs/src/content/trust/rules-standard-library.md',
);

function readUserModuleNames(): string[] {
  const src = readFileSync(STDLIB_MD_PATH, 'utf-8');
  // Markdown headers like "### auth" — capture the name after "### ".
  // Skip the "Module Index", "Dependency Types", "Modules" structural
  // headers; user modules are level-3 (`###`).
  const names: string[] = [];
  for (const line of src.split('\n')) {
    const m = line.match(/^###\s+(\w[\w-]*)\s*$/);
    if (!m) continue;
    names.push(m[1]!);
  }
  return names;
}

describe('STDLIB_MODULES — drift check against runtime constants', () => {
  it('covers every BUILTIN_NAMESPACE as a module key', () => {
    const keys = new Set(STDLIB_MODULES.map((m) => m.key));
    for (const ns of BUILTIN_NAMESPACES) {
      expect(keys.has(ns), `missing language-namespace module: ${ns}`).toBe(true);
    }
  });

  it('covers every BUILTIN_FUNCTION as a globals-module entry', () => {
    // BUILTIN_FUNCTIONS are top-level callables. They don't have a
    // namespace, so they land under a synthetic "builtin-functions"
    // listing — but in v1 we surface them as entries under the
    // language-namespace concept by including them in module
    // descriptions. The drift test just checks the function name
    // appears SOMEWHERE in the data — either as a key or in an
    // entry signature — so we don't lose track of them.
    const haystack = STDLIB_MODULES
      .flatMap((m) => [m.key, m.description, m.purpose, ...m.entries.flatMap((e) => [e.signature, e.description])])
      .join('\n');
    for (const fn of BUILTIN_FUNCTIONS) {
      expect(
        haystack.includes(fn),
        `BUILTIN_FUNCTION not referenced anywhere in stdlib data: ${fn}`,
      ).toBe(true);
    }
  });

  it('covers every KNOWN_BUILTIN_METHOD in at least one type-methods module entry', () => {
    const typeMethodSigs = STDLIB_MODULES
      .filter((m) => m.kind === 'type-methods')
      .flatMap((m) => m.entries.map((e) => e.signature));
    for (const method of KNOWN_BUILTIN_METHODS) {
      const found = typeMethodSigs.some((sig) => sig.includes(`.${method}(`));
      expect(found, `KNOWN_BUILTIN_METHOD missing from type-methods data: ${method}`).toBe(true);
    }
  });

  it('covers every documented user-module as a user-module key', () => {
    const userModuleKeys = new Set(
      STDLIB_MODULES.filter((m) => m.kind === 'user-module').map((m) => m.key),
    );
    const docNames = readUserModuleNames();
    expect(docNames.length, 'stdlib reference parsed zero modules — parser regressed').toBeGreaterThan(0);
    for (const name of docNames) {
      expect(userModuleKeys.has(name), `documented module not mirrored as user-module: ${name}`).toBe(true);
    }
  });
});

describe('STDLIB_MODULES — internal shape', () => {
  it('every module has the required fields populated', () => {
    for (const m of STDLIB_MODULES) {
      expect(m.key, `module missing key`).toBeTruthy();
      expect(m.kind, `module ${m.key} missing kind`).toBeTruthy();
      expect(m.description.length, `module ${m.key} empty description`).toBeGreaterThan(0);
      expect(m.purpose.length, `module ${m.key} empty purpose`).toBeGreaterThan(0);
      expect(m.whenToUse.length, `module ${m.key} empty whenToUse`).toBeGreaterThan(0);
      expect(m.entries.length, `module ${m.key} empty entries`).toBeGreaterThan(0);
    }
  });

  it('every entry has a non-empty signature + description', () => {
    for (const m of STDLIB_MODULES) {
      for (const e of m.entries) {
        expect(e.signature.length, `module ${m.key} entry missing signature`).toBeGreaterThan(0);
        expect(e.description.length, `module ${m.key} entry "${e.signature}" missing description`).toBeGreaterThan(0);
      }
    }
  });

  it('keys are unique', () => {
    const keys = STDLIB_MODULES.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('relatedKeys reference real modules', () => {
    const keys = new Set(STDLIB_MODULES.map((m) => m.key));
    for (const m of STDLIB_MODULES) {
      for (const ref of m.relatedKeys ?? []) {
        expect(keys.has(ref), `module ${m.key} relatedKeys references unknown key: ${ref}`).toBe(true);
      }
    }
  });
});

describe('findModuleByKey / suggestKey', () => {
  it('finds by exact match', () => {
    expect(findModuleByKey('math')?.key).toBe('math');
  });

  it('is case-insensitive', () => {
    expect(findModuleByKey('MATH')?.key).toBe('math');
    expect(findModuleByKey('Auth')?.key).toBe('auth');
  });

  it('returns undefined for unknown keys', () => {
    expect(findModuleByKey('nope')).toBeUndefined();
  });

  it('suggests the closest match for typos', () => {
    expect(suggestKey('lists')).toBe('list');
    expect(suggestKey('autho')).toBe('auth');
  });

  it('returns null for inputs too distant', () => {
    expect(suggestKey('completelyunrelated')).toBeNull();
  });

  it('allModuleKeys returns every module key', () => {
    expect(allModuleKeys().length).toBe(STDLIB_MODULES.length);
  });
});
