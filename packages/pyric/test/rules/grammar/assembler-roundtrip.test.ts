import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
import { assembleRules } from '../../../src/rules/grammar/FirestoreAssembler.js';
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
 * (whitespace/quote normalization means raw strings differ) and `loc`
 * fields (the reassembled source has a different line layout, so source
 * positions are expected to differ — they're not structural).
 */
const NON_STRUCTURAL_KEYS = new Set(['raw', 'loc']);
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
