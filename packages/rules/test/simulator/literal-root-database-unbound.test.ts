/**
 * Replays `database-under-literal-root` from
 * `packages/conformance/observations/firestore/firestore-named-database-rules-api.json`
 * and verifies `database` is bound only when the root match declares a
 * `{database}` wildcard (#1432).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { firestoreRules, lint } from '../../src/index.js';

interface NamedDbObservation {
  behavior: Record<string, 'ALLOW' | 'DENY'>;
  diagnostics: Record<
    string,
    {
      ruleset: string;
      issues: string[];
      cases: Record<string, { decision: 'ALLOW' | 'DENY'; debugMessages: string[] }>;
    }
  >;
}

const observation = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      '../../../conformance/observations/firestore/firestore-named-database-rules-api.json',
    ),
    'utf-8',
  ),
) as NamedDbObservation;

describe('database binding under literal and non-database root matches (#1432)', () => {
  test('replays database-under-literal-root from firestore-named-database-rules-api.json', () => {
    const probe = observation.diagnostics['database-under-literal-root'];
    if (probe === undefined) throw new Error('missing database-under-literal-root probe');

    expect(probe.issues).toEqual(['WARNING Invalid variable name: database.']);
    expect(observation.behavior['database-under-literal-root:get probes/p/d1']).toBe('DENY');
    expect(observation.behavior['database-under-literal-root:get (default)/p/d1']).toBe('DENY');

    const issues = lint(probe.ruleset);
    const sem5 = issues.find((i) => i.code === 'SEM-5');
    expect(sem5?.message).toContain('database');

    const sim = firestoreRules(probe.ruleset).simulate([
      {
        description: 'get p/d1 under literal probes root',
        expectation: 'DENY',
        method: 'get',
        path: 'p/d1',
        auth: { uid: 'a' },
      },
    ]);
    expect(sim.passed).toBe(1);
    expect(sim.cases[0]?.decision).toBe('DENY');
  });

  test('leaves database unbound under literal /databases/(default)/documents in rules and helpers', () => {
    const literalDefaultRoot = `rules_version = '2';
service cloud.firestore {
  match /databases/(default)/documents {
    function usesDatabaseAtRoot() {
      return database == '(default)';
    }
    match /p/{d} {
      function usesDatabaseInChild() {
        return database == '(default)';
      }
      allow get: if database == '(default)';
      allow create: if usesDatabaseAtRoot();
      allow update: if usesDatabaseInChild();
    }
  }
}`;

    const issues = lint(literalDefaultRoot);
    const unboundDbIssues = issues.filter(
      (i) => i.code === 'SEM-5' && i.message.includes('database'),
    );
    expect(unboundDbIssues.length).toBeGreaterThanOrEqual(3);

    const sim = firestoreRules(literalDefaultRoot).simulate([
      {
        description: 'direct allow rule reading database under literal (default) root denies',
        expectation: 'DENY',
        method: 'get',
        path: 'p/d1',
      },
      {
        description: 'root helper reading database under literal (default) root denies',
        expectation: 'DENY',
        method: 'create',
        path: 'p/d1',
        data: { x: 1 },
      },
      {
        description: 'child helper reading database under literal (default) root denies',
        expectation: 'DENY',
        method: 'update',
        path: 'p/d1',
        resource: { x: 0 },
        data: { x: 1 },
      },
    ]);
    expect(sim.passed).toBe(3);
    for (const c of sim.cases) {
      expect(c.decision).toBe('DENY');
      expect(c.trace[0]?.verdict).toBe('ERROR');
    }
  });

  test('leaves database unbound when the root wildcard uses a different name such as {db}', () => {
    const dbWildcardRoot = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /p/{d} {
      allow get: if database == '(default)';
      allow create: if db == '(default)';
    }
  }
}`;
    const sim = firestoreRules(dbWildcardRoot).simulate([
      {
        description: 'database is unbound under {db} root',
        expectation: 'DENY',
        method: 'get',
        path: 'p/d1',
      },
      {
        description: 'db binds (default) under {db} root',
        expectation: 'ALLOW',
        method: 'create',
        path: 'p/d1',
        data: { ok: true },
      },
    ]);
    expect(sim.passed).toBe(2);
  });

  test('list query budget projection for dynamic get(resource.data.ref) works under literal and {db} roots', () => {
    for (const rootHeader of [
      'match /databases/(default)/documents',
      'match /databases/{db}/documents',
    ]) {
      const ruleset = `rules_version = '2';
service cloud.firestore {
  ${rootHeader} {
    match /items/{id} {
      allow list: if (resource.data.flag == true && get(resource.data.ref).data.ok == true)
        || request.auth != null;
    }
  }
}`;
      const sim = firestoreRules(ruleset).simulate([
        {
          description: `list under ${rootHeader}`,
          expectation: 'ALLOW',
          method: 'list',
          path: 'items',
          auth: { uid: 'u1' },
        },
      ]);
      expect(sim.passed).toBe(1);
      expect(sim.cases[0]?.decision).toBe('ALLOW');
      expect(sim.cases[0]?.queryProof?.verdict).toBe('PROVABLE');
    }
  });
});
