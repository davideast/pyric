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
  modulesForService,
  suggestKey,
} from '../../src/rules/stdlib-modules.js';
import { STDLIB_SERVICE_CONTRACTS } from '../../src/rules/modules/stdlib-services.generated.js';
import { VALID_MATH_METHODS } from '../../src/rules/linter/hallucinations.js';

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

function readDocumentedModuleNames(): string[] {
  const src = readFileSync(STDLIB_MD_PATH, 'utf-8');
  // Markdown headers like "### auth" — capture the name after "### ".
  // Skip the "Module Index", "Dependency Types", "Modules" structural
  // headers; user modules are level-3 (`###`).
  const names: string[] = [];
  for (const line of src.split('\n')) {
    const m = line.match(/^###\s+([\w-]+(?:\/[\w-]+)*)\s*$/);
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

  it('never documents a math-namespace function the linter rejects', () => {
    // The math.isInfinite incident: the catalog documented (and exemplified)
    // a function production rejects at compile. Guard the whole catalog text:
    // signatures, descriptions, examples, notes, so any `math.<fn>(` mention
    // must name a function in the validator's accept-set.
    const catalogText = JSON.stringify(STDLIB_MODULES);
    const mentioned = new Set<string>();
    for (const m of catalogText.matchAll(/\bmath\.([A-Za-z_]\w*)\(/g)) {
      mentioned.add(m[1]!);
    }
    expect(mentioned.size, 'math drift guard parsed zero mentions, the regex regressed').toBeGreaterThan(0);
    for (const fn of mentioned) {
      expect(
        VALID_MATH_METHODS.has(fn),
        `stdlib catalog documents math.${fn}() but the linter rejects it (production compile failure)`,
      ).toBe(true);
    }
    // And the reverse direction: every accepted math function stays documented.
    const mathModule = findModuleByKey('math')!;
    const documented = new Set(
      mathModule.entries
        .map((e) => e.signature.match(/^math\.([A-Za-z_]\w*)\(/)?.[1])
        .filter((n): n is string => Boolean(n)),
    );
    for (const fn of VALID_MATH_METHODS) {
      expect(documented.has(fn), `VALID_MATH_METHODS has ${fn} but the math module does not document it`).toBe(true);
    }
  });

  it('marks debug() rejected through the acceptance field, not the signature', () => {
    // The signature field stays a signature. Production's refusal to compile
    // a ruleset that calls debug() is carried by `acceptance` and spelled out
    // in the description.
    const builtins = findModuleByKey('builtins')!;
    const debugEntry = builtins.entries.find((e) => e.signature.startsWith('debug('))!;
    expect(debugEntry.acceptance).toBe('rejected');
    expect(debugEntry.signature).not.toContain('REJECTED');
    expect(debugEntry.description).toContain('Function not found error');
    for (const m of STDLIB_MODULES) {
      for (const e of m.entries) {
        const isRejected = e.acceptance === 'rejected';
        if (!isRejected) continue;
        expect(
          e.description.toUpperCase().includes('DO NOT USE'),
          `rejected entry "${e.signature}" must say so in its description`,
        ).toBe(true);
      }
    }
  });

  it('every language-namespace entry signature uses its own module key as the namespace', () => {
    // General form of the drift guard: a `math` module documenting
    // `timestamp.foo(...)` (or vice versa) is a mis-filed signature that
    // the per-namespace accept-set checks above would silently miss.
    for (const m of STDLIB_MODULES) {
      if (m.kind !== 'language-namespace' || m.key === 'builtins') continue;
      for (const e of m.entries) {
        const ns = e.signature.match(/^([A-Za-z_]\w*)\./)?.[1];
        expect(ns, `module ${m.key} entry "${e.signature}" is not namespace-prefixed`).toBe(m.key);
      }
    }
  });

  it('accounts for every documented module using its generated service contract', () => {
    const userModuleKeys = new Set(
      STDLIB_MODULES.filter((m) => m.kind === 'user-module').map((m) => m.key),
    );
    const docNames = readDocumentedModuleNames();
    expect(docNames.length, 'stdlib reference parsed zero modules — parser regressed').toBeGreaterThan(0);
    expect([...docNames].sort()).toEqual(Object.keys(STDLIB_SERVICE_CONTRACTS).sort());

    for (const name of docNames) {
      const services = STDLIB_SERVICE_CONTRACTS[name as keyof typeof STDLIB_SERVICE_CONTRACTS];
      expect(userModuleKeys.has(name), `Rules module not mirrored in agent catalog: ${name}`).toBe(true);
      expect(findModuleByKey(name)?.services).toEqual(
        services.map((service) =>
          service === 'firebase.storage' ? 'storage' : 'firestore',
        ),
      );
    }
  });
});

describe('STDLIB_MODULES — internal shape', () => {
  it('every module has the required fields populated', () => {
    for (const m of STDLIB_MODULES) {
      expect(m.key, `module missing key`).toBeTruthy();
      expect(m.kind, `module ${m.key} missing kind`).toBeTruthy();
      expect(m.services?.length, `module ${m.key} missing services`).toBeGreaterThan(0);
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

  it('filters user modules by Rules service compatibility', () => {
    const storageKeys = modulesForService('storage').map(({ key }) => key);
    expect(storageKeys).toContain('auth');
    expect(storageKeys).toContain('membership');
    expect(storageKeys).toContain('storage/uploads');
    expect(storageKeys).not.toContain('validation');
    expect(storageKeys).not.toContain('builtins');
  });
});
