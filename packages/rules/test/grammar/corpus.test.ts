import { describe, test, expect } from 'bun:test';
import { parseRulesFile } from '../../src/grammar/FirestoreParser.js';
import { checkRulesSource } from '../../src/grammar/source-compile-limits.js';
import { firestoreRules, lint } from '../../src/index.js';
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
      // 008-wrong-service: serviceName accepts any letter sequence; production compiles it and denies Firestore requests (#1434)
      // 012-unsupported-rules-version, 013-invalid-regex-lookahead: grammar accepts tokens, compile check rejects them.
      const shouldParse =
        name.includes('008-wrong-service') ||
        name.includes('012-unsupported-rules-version') ||
        name.includes('013-invalid-regex-lookahead');
      const shouldCompile = name.includes('008-wrong-service');

      test(name + (shouldParse ? ' (semantic/compile check -- parser accepts)' : ''), () => {
        const result = parseRulesFile(content);
        expect(result.valid).toBe(shouldParse);
        const compiled = checkRulesSource(content);
        expect(compiled.ok).toBe(shouldCompile);
      });
    }

    test('008-wrong-service and unknown service blocks compile in firestoreRules(), deny all Firestore operations, and surface advisory lint warnings', () => {
      const wrongServiceContent = readFileSync(join(CORPUS, 'invalid', '008-wrong-service.rules'), 'utf-8');
      const storageRuleset = firestoreRules(wrongServiceContent);
      const storageSummary = storageRuleset.simulate([
        { description: 'get items/d1', expectation: 'DENY', method: 'get', path: 'items/d1' },
        { description: 'list items', expectation: 'DENY', method: 'list', path: 'items' },
        { description: 'create items/d1', expectation: 'DENY', method: 'create', path: 'items/d1', data: { v: 1 } },
      ]);
      expect(storageSummary.passed).toBe(3);
      expect(storageSummary.cases.every((c) => c.decision === 'DENY')).toBe(true);
      expect(storageSummary.cases[0]?.notes.join(' ')).toContain("service firebase.storage");
      expect(storageRuleset.lint()).toContainEqual(
        expect.objectContaining({ code: 'MISSING_FIRESTORE_SERVICE', severity: 'warning', line: 2 }),
      );
      expect(lint(wrongServiceContent).some((i) => i.code === 'MISSING_FIRESTORE_SERVICE')).toBe(false);

      const unknownService = `rules_version = '2';\nservice foo.bar {\n  match /items/{id} {\n    allow read: if true;\n  }\n}`;
      const unknownRuleset = firestoreRules(unknownService);
      const unknownSummary = unknownRuleset.simulate([
        { description: 'get items/d1', expectation: 'DENY', method: 'get', path: 'items/d1' },
      ]);
      expect(unknownSummary.passed).toBe(1);
      expect(unknownSummary.cases[0]?.decision).toBe('DENY');
      expect(lint(unknownService)).toContainEqual(
        expect.objectContaining({
          code: 'INVALID_SERVICE_NAME',
          severity: 'warning',
          line: 2,
          message: 'Invalid service name: foo.bar.',
        }),
      );
    });
  });
});
