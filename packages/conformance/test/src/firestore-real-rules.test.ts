import { describe, expect, test } from 'bun:test';
import {
  injectFirestoreProbeRules,
  hostedTestApiDiagnostics,
  replaceSelectedRulesFile,
  selectFirestoreRulesFile,
} from '../../src/firestore-real-rules.ts';

describe('Firestore real-probe rules lifecycle', () => {
  const ruleset = {
    name: 'projects/p/rulesets/original',
    source: {
      files: [
        { name: 'helpers.rules', content: 'function helper() { return true; }' },
        {
          name: 'firestore.rules',
          content: "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n  }\n}\n",
        },
      ],
    },
  };

  test('injects only an isolated run path inside the Firestore documents match', () => {
    const selected = selectFirestoreRulesFile(ruleset);
    const next = injectFirestoreProbeRules(selected.content, 'run-123');

    expect(next).toContain('match /__pyric_firestore_cdd/run-123/browser/{document=**}');
    expect(next).toContain('match /__pyric_firestore_cdd/run-123/rules_get_after/{caseId}');
    expect(next).toContain('getAfter(request.path).data.x == request.resource.data.x');
    expect(next).toContain('existsAfter(request.path)');
    expect(next).toContain('allow read, write: if request.auth != null;');
    expect(next).toContain("rules_version = '2';");
  });

  test('preserves every non-Firestore source file byte-for-byte', () => {
    const selected = selectFirestoreRulesFile(ruleset);
    const files = replaceSelectedRulesFile(
      ruleset,
      selected,
      injectFirestoreProbeRules(selected.content, 'run-123'),
    );

    expect(files[0]).toEqual(ruleset.source.files[0]);
    expect(files[1]!.name).toBe('firestore.rules');
    expect(files[1]!.content).not.toBe(selected.content);
  });

  test('keeps retained hosted diagnostics idempotent across recaptures', () => {
    const leaf = { case: { notes: ['Function not found'] } };
    expect(hostedTestApiDiagnostics(leaf)).toBe(leaf);
    expect(hostedTestApiDiagnostics({
      productionDatabase: {},
      hostedTestApiLimitation: {
        productionDatabase: {},
        hostedTestApiLimitation: leaf,
      },
    })).toBe(leaf);
  });
});
