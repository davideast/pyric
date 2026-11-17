import { describe, test, expect } from 'bun:test';
import { parseRulesFile } from '../../src/grammar/FirestoreParser.js';
import { checkRulesSource } from '../../src/grammar/source-compile-limits.js';
import { firestoreRules } from '../../src/index.js';
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

describe('Firestore Grammar -- Full Corpus', () => {
  describe('valid files (must parse and compile)', () => {
    const files = loadCorpusFiles('valid');
    for (const { name, content } of files) {
      test(name, () => {
        const result = parseRulesFile(content);
        expect(result.valid).toBe(true);
        expect(checkRulesSource(content).ok).toBe(true);
      });
    }
  });

  describe('edge-case files (must parse and compile)', () => {
    const files = loadCorpusFiles('edge-cases');
    for (const { name, content } of files) {
      test(name, () => {
        const result = parseRulesFile(content);
        expect(result.valid).toBe(true);
        expect(checkRulesSource(content).ok).toBe(true);
      });
    }

    test('009-wrong-service and unknown service blocks compile in firestoreRules() and deny all Firestore operations', () => {
      const wrongServiceContent = readFileSync(join(CORPUS, 'edge-cases', '009-wrong-service.rules'), 'utf-8');
      const storageRuleset = firestoreRules(wrongServiceContent);
      const storageSummary = storageRuleset.simulate([
        { description: 'get items/d1', expectation: 'DENY', method: 'get', path: 'items/d1' },
        { description: 'list items', expectation: 'DENY', method: 'list', path: 'items' },
        { description: 'create items/d1', expectation: 'DENY', method: 'create', path: 'items/d1', data: { v: 1 } },
      ]);
      expect(storageSummary.passed).toBe(3);
      expect(storageSummary.cases.every((c) => c.decision === 'DENY')).toBe(true);
      expect(storageSummary.cases[0]?.notes.join(' ')).toContain('service firebase.storage');

      const unknownService = `rules_version = '2';\nservice foo.bar {\n  match /items/{id} {\n    allow read: if true;\n  }\n}`;
      const unknownSummary = firestoreRules(unknownService).simulate([
        { description: 'get items/d1', expectation: 'DENY', method: 'get', path: 'items/d1' },
      ]);
      expect(unknownSummary.passed).toBe(1);
      expect(unknownSummary.cases[0]?.decision).toBe('DENY');
    });
  });

  describe('invalid files (must fail parse or compile)', () => {
    const files = loadCorpusFiles('invalid');
    for (const { name, content } of files) {
      // 012-unsupported-rules-version, 013-invalid-regex-lookahead: grammar accepts tokens, compile check rejects them.
      const shouldParse =
        name.includes('012-unsupported-rules-version') ||
        name.includes('013-invalid-regex-lookahead');
      let suffix = '';
      if (shouldParse) {
        suffix = ' (compile check -- parser accepts)';
      }

      test(name + suffix, () => {
        const result = parseRulesFile(content);
        expect(result.valid).toBe(shouldParse);
        expect(checkRulesSource(content).ok).toBe(false);
      });
    }
  });
});
