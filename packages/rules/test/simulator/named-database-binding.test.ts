/**
 * Unit tests for Firestore named-database rules `{database}` binding,
 * `request.path` database prefixing, cross-database fail-closed lookups vs
 * explicit Rules Test API `functionMocks`, helper-function database context,
 * and list query budget projection on named databases (ADR-0021 C1/C2, MD4).
 */
import { describe, expect, test } from 'bun:test';
import { firestoreRules } from '../../src/index.js';
import { SimulateFirestoreRulesHandler } from '../../src/simulator/handler.js';

describe('Firestore rules simulator named-database binding (MD4)', () => {
  test('infers active database from full resource path and accepts matching opts.database', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /p/{d} {
      allow get: if database == 'probes'
        && request.path[1] == 'probes'
        && request.path == /databases/$(database)/documents/p/$(d);
    }
  }
}`;
    const publicSummary = firestoreRules(rules).simulate([
      {
        description: 'named db path allows',
        expectation: 'ALLOW',
        method: 'get',
        path: '/databases/probes/documents/p/d1',
      },
      {
        description: 'default db path denies',
        expectation: 'DENY',
        method: 'get',
        path: '/databases/(default)/documents/p/d1',
      },
      {
        description: 'relative path defaults to (default)',
        expectation: 'DENY',
        method: 'get',
        path: 'p/d1',
      },
    ]);
    expect(publicSummary.passed).toBe(3);

    const handler = new SimulateFirestoreRulesHandler();
    const withOpt = handler.simulate(
      rules,
      [
        {
          description: 'relative path with opts.database probes allows',
          expectation: 'ALLOW',
          method: 'get',
          path: 'p/d1',
        },
        {
          description: 'matching full path and opts.database allows',
          expectation: 'ALLOW',
          method: 'get',
          path: '/databases/probes/documents/p/d1',
        },
      ],
      { database: 'probes' },
    );
    expect(withOpt.success).toBe(true);
    if (withOpt.success) {
      expect(withOpt.data.passed).toBe(2);
    }
  });

  test('refuses mismatched opts.database vs path database and dot database ids fail-closed', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /p/{d} { allow get: if true; }
  }
}`;
    const handler = new SimulateFirestoreRulesHandler();
    const mismatch = handler.simulate(
      rules,
      [
        {
          description: 'conflicting path and option database',
          expectation: 'ALLOW',
          method: 'get',
          path: '/databases/other/documents/p/d1',
        },
      ],
      { database: 'probes' },
    );
    expect(mismatch.success).toBe(true);
    if (mismatch.success) {
      expect(mismatch.data.unsupported).toBe(1);
      expect(mismatch.data.results[0]?.decision).toBe('UNSUPPORTED');
      expect(mismatch.data.results[0]?.notes[0]).toContain('does not match target database');
    }

    const dotPath = handler.simulate(rules, [
      {
        description: 'dot database segment in path',
        expectation: 'ALLOW',
        method: 'get',
        path: '/databases/../documents/p/d1',
      },
    ]);
    expect(dotPath.success).toBe(true);
    if (dotPath.success) {
      expect(dotPath.data.unsupported).toBe(1);
      expect(dotPath.data.results[0]?.decision).toBe('UNSUPPORTED');
    }

    const dotOpt = handler.simulate(
      rules,
      [
        {
          description: 'dot database option',
          expectation: 'ALLOW',
          method: 'get',
          path: 'p/d1',
        },
      ],
      { database: '.' },
    );
    expect(dotOpt.success).toBe(true);
    if (dotOpt.success) {
      expect(dotOpt.data.unsupported).toBe(1);
      expect(dotOpt.data.results[0]?.decision).toBe('UNSUPPORTED');
    }
  });

  test('honors explicit cross-database functionMocks while failing closed on unmocked cross-database lookups', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /mocked-get/{d} {
      allow get: if get(/databases/(default)/documents/c/x).data.v == 1;
    }
    match /mocked-exists/{d} {
      allow get: if exists(/databases/(default)/documents/c/y);
    }
    match /unmocked/{d} {
      allow get: if !exists(/databases/(default)/documents/c/z);
    }
    match /unmocked-or-true/{d} {
      allow get: if get(/databases/(default)/documents/c/z).data.v == 1 || true;
    }
  }
}`;
    const summary = firestoreRules(rules).simulate([
      {
        description: 'explicit foreign get mock allows on probes',
        expectation: 'ALLOW',
        method: 'get',
        path: '/databases/probes/documents/mocked-get/d1',
        functionMocks: [
          {
            function: 'get',
            path: '/databases/(default)/documents/c/x',
            result: { v: 1 },
          },
        ],
      },
      {
        description: 'explicit foreign exists mock allows on probes',
        expectation: 'ALLOW',
        method: 'get',
        path: '/databases/probes/documents/mocked-exists/d1',
        functionMocks: [
          {
            function: 'exists',
            path: '/databases/(default)/documents/c/y',
            result: true,
          },
        ],
      },
      {
        description: 'unmocked !exists on foreign database denies with error',
        expectation: 'DENY',
        method: 'get',
        path: '/databases/probes/documents/unmocked/d1',
      },
      {
        description: 'unmocked foreign get absorbed by || true grants',
        expectation: 'ALLOW',
        method: 'get',
        path: '/databases/probes/documents/unmocked-or-true/d1',
      },
    ]);
    expect(summary.passed).toBe(4);
    expect(summary.cases[2]?.trace[0]?.verdict).toBe('ERROR');
  });

  test('charges explicit foreign functionMocks against the 10-lookup request budget', () => {
    const checks: string[] = [];
    const mocks: Array<{ function: 'exists'; path: string; result: boolean }> = [];
    for (let i = 1; i <= 11; i++) {
      const p = `/databases/(default)/documents/c/d${i}`;
      checks.push(`exists(${p})`);
      mocks.push({ function: 'exists', path: p, result: true });
    }
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /p/{d} {
      allow get: if ${checks.join(' && ')};
    }
  }
}`;
    const handler = new SimulateFirestoreRulesHandler();
    const res = handler.simulate(rules, [
      {
        description: '11 distinct mocked foreign lookups hit lookup limit',
        expectation: 'DENY',
        method: 'get',
        path: '/databases/probes/documents/p/d1',
        functionMocks: mocks,
      },
    ]);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.results[0]?.decision).toBe('DENY');
      expect(res.data.results[0]?.resourceLimit?.kind).toBe('document-lookups');
    }
  });

  test('preserves active database in top-level helper functions without exposing unbound database variable', () => {
    const rules = `rules_version = '2';
function checkProbes() {
  return get(/databases/probes/documents/cfg/one).data.ok == true;
}
function checkDefault() {
  return exists(/databases/(default)/documents/cfg/one);
}
service cloud.firestore {
  match /databases/probes/documents {
    match /own/{d} { allow get: if checkProbes(); }
    match /foreign/{d} { allow get: if checkDefault(); }
  }
}`;
    const handler = new SimulateFirestoreRulesHandler();
    const res = handler.simulate(
      rules,
      [
        {
          description: 'helper reading own named database allows',
          expectation: 'ALLOW',
          method: 'get',
          path: 'own/d1',
        },
        {
          description: 'helper reading foreign default database denies',
          expectation: 'DENY',
          method: 'get',
          path: 'foreign/d1',
        },
      ],
      {
        database: 'probes',
        getDoc: (p) => {
          if (p === 'cfg/one') return { ok: true };
          return null;
        },
      },
    );
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.passed).toBe(2);
      expect(res.data.results[1]?.trace[0]?.verdict).toBe('ERROR');
    }
  });

  test('projects dynamic list query budget refs against the named database and reports full name in noMatchNotes', () => {
    for (const rootHeader of [
      'match /databases/probes/documents',
      'match /databases/{db}/documents',
      'match /databases/{database}/documents',
    ]) {
      const rules = `rules_version = '2';
service cloud.firestore {
  ${rootHeader} {
    match /items/{id} {
      allow list: if (resource.data.flag == true && get(resource.data.ref).data.ok == true)
        || request.auth != null;
    }
  }
}`;
      const summary = firestoreRules(rules).simulate([
        {
          description: `list on probes under ${rootHeader}`,
          expectation: 'ALLOW',
          method: 'list',
          path: '/databases/probes/documents/items',
          auth: { uid: 'u1' },
        },
      ]);
      expect(summary.passed).toBe(1);
      expect(summary.cases[0]?.queryProof?.verdict).toBe('PROVABLE');
    }

    const literalDefault = `rules_version = '2';
service cloud.firestore {
  match /databases/(default)/documents {
    match /items/{id} { allow get: if true; }
  }
}`;
    const unmatched = firestoreRules(literalDefault).simulate([
      {
        description: 'unmatched named database reports probes in note',
        expectation: 'DENY',
        method: 'get',
        path: '/databases/probes/documents/items/i1',
      },
    ]);
    expect(unmatched.passed).toBe(1);
    expect(unmatched.cases[0]?.notes[0]).toContain('/databases/probes/documents/items/i1');
  });
});
