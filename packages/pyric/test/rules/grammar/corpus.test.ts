import { describe, test, expect } from 'bun:test';
import { parseRulesFile } from '../../../src/rules/grammar/FirestoreParser.js';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const CORPUS = join(import.meta.dir, '../corpus');

function loadCorpusFiles(dir: string): Array<{ name: string; content: string }> {
  const fullDir = join(CORPUS, dir);
  return readdirSync(fullDir)
    .filter(f => f.endsWith('.rules'))
    .sort()
    .map(name => ({ name, content: readFileSync(join(fullDir, name), 'utf-8') }));
}

describe('Firestore Grammar — Full Corpus', () => {
  describe('valid files (must parse)', () => {
    const files = loadCorpusFiles('valid');
    for (const { name, content } of files) {
      test(name, () => {
        const result = parseRulesFile(content);
        if (!result.valid) {
          console.log(`  ${name} FAILED:`, result.errors[0]?.message?.substring(0, 200));
        }
        expect(result.valid).toBe(true);
      });
    }
  });

  describe('edge-case files (must parse)', () => {
    const files = loadCorpusFiles('edge-cases');
    for (const { name, content } of files) {
      test(name, () => {
        const result = parseRulesFile(content);
        if (!result.valid) {
          console.log(`  ${name} FAILED:`, result.errors[0]?.message?.substring(0, 200));
        }
        expect(result.valid).toBe(true);
      });
    }
  });

  describe('invalid files (must reject)', () => {
    const files = loadCorpusFiles('invalid');
    for (const { name, content } of files) {
      // 006-function-no-return: our grammar requires return, so it's a syntax error
      // 008-wrong-service: serviceName accepts any letter sequence — semantic error
      const shouldParse = name.includes('008-wrong-service');

      test(name + (shouldParse ? ' (semantic error — parser accepts)' : ''), () => {
        const result = parseRulesFile(content);
        expect(result.valid).toBe(shouldParse);
      });
    }
  });
});
