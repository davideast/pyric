import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { firestoreRules, lint, type FirestoreCase } from 'pyric/rules';
import { SimulateFirestoreRulesHandler } from 'pyric/rules/internal';
import { expectReplay, load } from './support.ts';

interface ApiFunctionMock {
  readonly function: 'get' | 'exists';
  readonly args: ReadonlyArray<{ readonly exactValue: string }>;
  readonly result: { readonly value: unknown };
}

interface RulesApiProbeDiagnostic {
  readonly ruleset: string;
  readonly functionMocks: readonly ApiFunctionMock[];
  readonly issues: readonly string[];
  readonly cases: Readonly<Record<string, { readonly decision: 'ALLOW' | 'DENY' }>>;
}

interface RulesApiObservationFile {
  readonly diagnostics: Readonly<Record<string, RulesApiProbeDiagnostic>>;
}

const OBS_PATH = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'firestore',
  'firestore-named-database-rules-api.json',
);

function convertFunctionMocks(
  mocks: readonly ApiFunctionMock[],
): NonNullable<FirestoreCase['functionMocks']> {
  const out: NonNullable<FirestoreCase['functionMocks']> = [];
  for (const mock of mocks) {
    const arg = mock.args[0];
    if (arg === undefined) continue;
    if (mock.function === 'get') {
      const value = mock.result.value as { data?: Record<string, unknown> } | Record<string, unknown>;
      let docData: Record<string, unknown> = {};
      if (value !== null && typeof value === 'object' && 'data' in value && value.data !== undefined) {
        docData = value.data;
      } else if (value !== null && typeof value === 'object') {
        docData = value as Record<string, unknown>;
      }
      out.push({ function: 'get', path: arg.exactValue, result: docData });
    } else if (mock.function === 'exists') {
      out.push({ function: 'exists', path: arg.exactValue, result: mock.result.value === true });
    }
  }
  return out;
}

describe('Firestore named-database Rules Test API oracle capture (ADR-0021 C1)', () => {
  it('replays every probe in firestore-named-database-rules-api (firestore#MD4)', () => {
    const production = load('firestore-named-database-rules-api');
    const raw = JSON.parse(readFileSync(OBS_PATH, 'utf8')) as RulesApiObservationFile;
    const handler = new SimulateFirestoreRulesHandler();

    const actualByPath: Record<string, string> = {};
    const actualByOption: Record<string, string> = {};

    for (const [probeName, diag] of Object.entries(raw.diagnostics)) {
      const ruleset = firestoreRules(diag.ruleset);
      const functionMocks = convertFunctionMocks(diag.functionMocks);

      if (diag.issues.length > 0) {
        const lintIssues = lint(diag.ruleset);
        expect(lintIssues.some((issue) => issue.code === 'SEM-5')).toBe(true);
      }

      for (const caseLabel of Object.keys(diag.cases)) {
        const match = /^get ([^/]+)\/(.+)$/.exec(caseLabel);
        if (!match) {
          throw new Error(`Unexpected case label: ${caseLabel}`);
        }
        const databaseId = match[1];
        const relPath = match[2];
        if (databaseId === undefined || relPath === undefined) {
          throw new Error(`Incomplete case label: ${caseLabel}`);
        }
        const key = `${probeName}:${caseLabel}`;

        const pathCase: FirestoreCase = {
          description: key,
          expectation: 'ALLOW',
          method: 'get',
          path: `/databases/${databaseId}/documents/${relPath}`,
          auth: { uid: 'a' },
        };
        if (functionMocks.length > 0) {
          pathCase.functionMocks = functionMocks;
        }
        const pathSummary = ruleset.simulate([pathCase]);
        actualByPath[key] = pathSummary.cases[0]?.decision ?? 'UNSUPPORTED';

        const optCase: FirestoreCase = {
          description: key,
          expectation: 'ALLOW',
          method: 'get',
          path: relPath,
          auth: { uid: 'a' },
        };
        if (functionMocks.length > 0) {
          optCase.functionMocks = functionMocks;
        }
        const optResult = handler.simulate(diag.ruleset, [optCase as never], {
          database: databaseId,
        });
        expect(optResult.success).toBe(true);
        if (optResult.success) {
          actualByOption[key] = optResult.data.results[0]?.decision ?? 'UNSUPPORTED';
        }
      }
    }

    expectReplay({ production, pyric: actualByPath });
    expectReplay({ production, pyric: actualByOption });
  });
});
