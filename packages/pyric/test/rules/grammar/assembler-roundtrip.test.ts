import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
import { assembleRules, assembleExpression } from '../../../src/rules/grammar/FirestoreAssembler.js';
import { resolveModulesWith } from '../../../src/rules/modules/resolver-core.js';
import type { Expression, MatchBlock, FunctionDef } from '../../../src/rules/grammar/FirestoreAST.js';

const CORPUS = join(import.meta.dir, '../corpus');

function loadFiles(dir: string): Array<{ name: string; content: string }> {
  const fullDir = join(CORPUS, dir);
  return readdirSync(fullDir)
    .filter(f => f.endsWith('.rules'))
    .sort()
    .map(f => ({ name: f, content: readFileSync(join(fullDir, f), 'utf-8') }));
}

/**
 * Deep structural comparison of two ASTs, ignoring `raw` fields
 * (whitespace normalization means raw strings can differ) and `loc`
 * fields (the reassembled source has a different line layout, so source
 * positions are expected to differ — they're not structural).
 */
const NON_STRUCTURAL_KEYS = new Set(['raw', 'loc', 'returnLoc']);
function structuralEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;

  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => structuralEqual(item, (b as unknown[])[i]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj).filter(k => !NON_STRUCTURAL_KEYS.has(k));
  const bKeys = Object.keys(bObj).filter(k => !NON_STRUCTURAL_KEYS.has(k));

  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(k => structuralEqual(aObj[k], bObj[k]));
}

const validFiles = loadFiles('valid');
const edgeCaseFiles = loadFiles('edge-cases');

describe('assembler round-trip — valid corpus', () => {
  for (const file of validFiles) {
    test(`${file.name}: parse → assemble → reparse`, () => {
      const ast1 = parseToAST(file.content);
      expect(ast1).not.toBeNull();

      const assembled = assembleRules(ast1!);
      const ast2 = parseToAST(assembled);

      expect(ast2).not.toBeNull();
      if (!structuralEqual(ast1, ast2)) {
        // Provide useful diff on failure
        expect(JSON.stringify(ast2, null, 2)).toBe(JSON.stringify(ast1, null, 2));
      }
    });
  }
});

describe('assembler round-trip — edge cases', () => {
  for (const file of edgeCaseFiles) {
    test(`${file.name}: parse → assemble → reparse`, () => {
      const ast1 = parseToAST(file.content);
      expect(ast1).not.toBeNull();

      const assembled = assembleRules(ast1!);
      const ast2 = parseToAST(assembled);

      expect(ast2).not.toBeNull();
      if (!structuralEqual(ast1, ast2)) {
        expect(JSON.stringify(ast2, null, 2)).toBe(JSON.stringify(ast1, null, 2));
      }
    });
  }
});

describe('assembler idempotency', () => {
  const keyFiles = ['021-production-blockingfun.rules', '020-complex-real-world.rules', '008-functions.rules'];
  for (const name of keyFiles) {
    test(`${name}: second round-trip produces identical text`, () => {
      const file = validFiles.find(f => f.name === name)!;
      const text1 = assembleRules(parseToAST(file.content)!);
      const text2 = assembleRules(parseToAST(text1)!);
      expect(text1).toBe(text2);
    });
  }
});

test('preserves global and service-scope functions', () => {
  const source = `rules_version = '2';
function globalHelper() { return true; }
service cloud.firestore {
  function serviceHelper() { return globalHelper(); }
  match /databases/{database}/documents {
    match /{document=**} {
      allow read: if serviceHelper();
    }
  }
}`;
  const ast1 = parseToAST(source)!;

  const ast2 = parseToAST(assembleRules(ast1));

  expect(ast2).not.toBeNull();
  expect(ast2!.functions?.map((fn) => fn.name)).toEqual(['globalHelper']);
  expect(ast2!.service.functions?.map((fn) => fn.name)).toEqual(['serviceHelper']);
  expect(structuralEqual(ast1, ast2)).toBe(true);
});

describe('pathLiteral parenthesization in postfix and division expressions (FS-FUZ-2)', () => {
  const wrap = (expr: string) =>
    `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /t/{id} {\n      allow read: if ${expr};\n    }\n  }\n}`;

  test('preserves parentheses around pathLiteral receiver in methodCall and memberAccess', () => {
    for (const expr of [
      "(/users/alice).bind(['x']) == /users/alice",
      '(/users/$(request.auth.uid)).foo == 1',
    ]) {
      const ast1 = parseToAST(wrap(expr));
      expect(ast1).not.toBeNull();
      const assembled = assembleRules(ast1!);
      const ast2 = parseToAST(assembled);
      expect(ast2).not.toBeNull();
      expect(structuralEqual(ast1, ast2)).toBe(true);
    }
  });

  test('preserves division after pathLiteral and does not merge / 2 into path segments', () => {
    const ast1 = parseToAST(wrap('(/users/alice) / 2 == 1'));
    expect(ast1).not.toBeNull();
    const cond1 = ast1!.service.match.children[0]!.allows[0]!.condition;
    expect(assembleExpression(cond1)).toBe('(/users/alice) / 2 == 1');
    const ast2 = parseToAST(assembleRules(ast1!));
    expect(ast2).not.toBeNull();
    expect(structuralEqual(ast1, ast2)).toBe(true);
  });

  test('resolveModulesWith round-trips an imported function containing (/users/$(uid)).bind(...)', () => {
    const entry = `rules_version = '2+modules';\nimport { checkPath } from './helpers.rules';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /t/{id} {\n      allow read: if checkPath(request.auth.uid);\n    }\n  }\n}`;
    const helper = `export function checkPath(uid) {\n  return (/users/$(uid)).bind(['x']) == /users/$(uid);\n}`;
    const resolved = resolveModulesWith(null, entry, {
      modules: { './helpers.rules': helper },
    });
    expect(resolved.success).toBe(true);
    if (resolved.success) {
      expect(parseToAST(resolved.data.resolved)).not.toBeNull();
    }
  });
});
