import { describe, expect, test } from 'bun:test';
import {
  injectFirestoreProbeRules,
  hostedTestApiDiagnostics,
  replaceSelectedRulesFile,
  selectFirestoreRulesFile,
  TRANSACTION_CASE_IDS,
  transactionCasePath,
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
    expect(next).toContain('match /__pyric_firestore_cdd/run-123/rules_atomic_batch/{caseId}');
    expect(next).toContain(
      "getAfter(/databases/$(database)/documents/__pyric_firestore_cdd/run-123/rules_atomic_batch/config_state).data.modified == true",
    );
    expect(next).toContain('allow read, write: if request.auth != null;');
    expect(next).toContain("rules_version = '2';");
  });

  test('scopes the collection-group listener rules to collection ids that carry the run id', () => {
    const next = injectFirestoreProbeRules(selectFirestoreRulesFile(ruleset).content, 'run123');

    expect(next).toContain('match /{path=**}/cdd_items_run123/{id}');
    expect(next).toContain('match /__pyric_firestore_cdd/run123/users/{uid}/cdd_other_run123/{id}');
  });

  test('grants the transaction-contention documents the capture writes, and nothing beside them', async () => {
    const { SimulateFirestoreRulesHandler } = await import('../../../pyric/src/rules/simulator/handler.ts');
    const rules = injectFirestoreProbeRules(selectFirestoreRulesFile(ruleset).content, 'run123');
    const signedIn = { uid: 'pyric-cdd-run123' };
    const cases = [
      ...TRANSACTION_CASE_IDS.flatMap((caseId) => (['create', 'update', 'get'] as const).map((method) => ({
        description: `${method} ${caseId}`,
        expectation: 'ALLOW' as const,
        method,
        path: transactionCasePath('run123', caseId),
        auth: signedIn,
        data: { count: 0 },
        ...(method === 'create' ? {} : { resource: { count: 0 } }),
      }))),
      {
        description: 'signed-out create retry',
        expectation: 'DENY' as const,
        method: 'create' as const,
        path: transactionCasePath('run123', 'retry'),
        data: { count: 0 },
      },
      {
        description: 'create a case id the capture does not use',
        expectation: 'DENY' as const,
        method: 'create' as const,
        path: '__pyric_firestore_cdd/run123/cases/other',
        auth: signedIn,
        data: { count: 0 },
      },
    ];
    const result = new SimulateFirestoreRulesHandler().simulate(rules, cases);
    if (!result.success) throw new Error(result.error.message);
    expect(Object.fromEntries(result.data.results.map((r) => [r.description, r.decision])))
      .toEqual(Object.fromEntries(cases.map((c) => [c.description, c.expectation])));
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
