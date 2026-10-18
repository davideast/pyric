import { describe, expect, test } from 'bun:test';
import {
  firestoreRules,
  explainCase,
  type FirestoreCase,
} from 'pyric/rules';
import {
  SimulateFirestoreRulesHandler,
  ListQuerySchema,
  buildApiTestCase,
} from 'pyric/rules/internal';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules, seedDocuments } from 'pyric/sandbox/firestore';
import { getFirestore, collection, getDocs, query, where } from 'pyric/firestore';

const PUBLIC_POSTS_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{postId} {
      allow read: if resource.data.visibility == 'public';
    }
    match /{document=**} {
      allow read, write: if false;
    }
  }
}`;

const OWNER_NOTES_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{noteId} {
      allow list: if request.auth != null && resource.data.owner == request.auth.uid;
    }
  }
}`;

describe('ListQuerySchema & buildApiTestCase (where constraints)', () => {
  test('ListQuerySchema accepts where constraints and buildApiTestCase strips where from wire request.query', () => {
    const parsed = ListQuerySchema.parse({
      where: [
        { field: 'visibility', op: '==', value: 'public' },
        { field: 'status', op: 'in', value: ['open', 'closed'] },
      ],
      limit: 25,
      orderBy: 'createdAt',
    });
    expect(parsed.where).toHaveLength(2);
    expect(parsed.limit).toBe(25);

    const api = buildApiTestCase({
      description: 'list with where',
      expectation: 'ALLOW',
      method: 'list',
      path: 'posts',
      query: parsed,
    });
    expect(api.request.query).toEqual({ limit: 25, orderBy: 'createdAt' });
  });
});

describe('simulate() list-query provability vs document-evaluation (#371)', () => {
  test('reports document-evaluation ALLOW and queryProof UNPROVABLE separately on a single-doc mock without where (PostBoard scenario)', () => {
    const ruleset = firestoreRules(PUBLIC_POSTS_RULES);
    const summary = ruleset.simulate([
      {
        description: 'list posts with mocked public doc but no where filter',
        expectation: 'ALLOW',
        method: 'list',
        path: 'posts/p1',
        resource: { visibility: 'public' },
      },
    ]);

    const res = summary.cases[0]!;
    // Document-evaluation passes against the mocked resource:
    expect(res.decision).toBe('ALLOW');
    expect(res.passed).toBe(true);
    // Static list-query proof is reported as a separate verdict (never merged):
    expect(res.queryProof).toBeDefined();
    expect(res.queryProof?.verdict).toBe('UNPROVABLE');
    expect(res.queryProof?.provable).toBe(false);
    expect(res.queryProof?.kind).toBe('constraints-not-satisfied');
    expect(res.queryProof?.reason).toContain('resource.data.visibility == "public"');
    expect(res.queryProof?.remediation).toContain(".where('visibility', '==', \"public\")");

    const explained = ruleset.explain({
      description: 'list posts with mocked public doc',
      expectation: 'ALLOW',
      method: 'list',
      path: 'posts/p1',
      resource: { visibility: 'public' },
    });
    expect(explained.decision).toBe('ALLOW');
    expect(explained.queryProof?.verdict).toBe('UNPROVABLE');
    expect(explainCase(res)).toContain('query proof: UNPROVABLE');
  });

  test('discharged query.where proves list rule and evaluates synthetic resource without a mocked document', () => {
    const handler = new SimulateFirestoreRulesHandler();
    const simResult = handler.simulate(PUBLIC_POSTS_RULES, [
      {
        description: 'list public posts with where filter',
        expectation: 'ALLOW',
        method: 'list',
        path: 'posts',
        query: {
          where: [{ field: 'visibility', op: '==', value: 'public' }],
        },
      },
    ]);
    expect(simResult.success).toBe(true);
    if (!simResult.success) return;

    const r = simResult.data.results[0]!;
    expect(r.decision).toBe('ALLOW');
    expect(r.state).toBe('PASSED');
    expect(r.queryProof?.verdict).toBe('PROVABLE');
    expect(r.queryProof?.provable).toBe(true);
    expect(r.queryProof?.kind).toBe('provable');
  });

  test('reports queryProof PROVABLE and document-evaluation DENY separately when residual auth check fails', () => {
    const ruleset = firestoreRules(OWNER_NOTES_RULES);
    const summary = ruleset.simulate([
      {
        description: 'unauthenticated caller with matching where filter',
        expectation: 'DENY',
        method: 'list',
        path: 'notes',
        auth: null,
        query: {
          where: [{ field: 'owner', op: '==', value: 'alice' }],
        },
      },
    ]);

    const res = summary.cases[0]!;
    expect(res.decision).toBe('DENY');
    expect(res.passed).toBe(true);
    expect(res.queryProof?.verdict).toBe('PROVABLE');
    expect(res.queryProof?.provable).toBe(true);
  });

  test('runtime unprovable-query denial emits a ready-to-run repro that reproduces in simulate()', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, OWNER_NOTES_RULES);
    seedDocuments(sandbox, {
      'notes/n1': { owner: 'alice', text: 'secret' },
    });
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));

    let caught: unknown;
    try {
      await getDocs(collection(db, 'notes'));
    } catch (e) {
      caught = e;
    }

    const err = caught as {
      code?: string;
      message?: string;
      remediation?: string;
      denialContext?: {
        repro?: {
          command: string;
          testCase: FirestoreCase;
        };
      };
    };
    expect(err.code).toBe('permission-denied');
    expect(err.remediation).toContain('Reproduce with:');
    expect(err.remediation).toContain('pyric rules simulate --service firestore --operation list --path notes --uid alice');
    expect(err.remediation).toContain('Fixture case:');

    const repro = err.denialContext?.repro;
    expect(repro).toBeDefined();
    expect(repro?.command).toBe('pyric rules simulate --service firestore --operation list --path notes --uid alice');

    // Copy-pasting the repro testCase into simulate() reproduces the unprovable verdict:
    const ruleset = firestoreRules(OWNER_NOTES_RULES);
    const reproduced = ruleset.simulate([repro!.testCase]).cases[0]!;
    expect(reproduced.queryProof?.verdict).toBe('UNPROVABLE');

    // Adding the suggested where clause makes both verdicts pass:
    const fixed = ruleset.simulate([
      {
        ...repro!.testCase,
        query: { where: [{ field: 'owner', op: '==', value: 'alice' }] },
      },
    ]).cases[0]!;
    expect(fixed.queryProof?.verdict).toBe('PROVABLE');
    expect(fixed.decision).toBe('ALLOW');
    expect(fixed.passed).toBe(true);
  });

  test('runtime unprovable-query denial with existing where constraints includes --query in repro', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, PUBLIC_POSTS_RULES);
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));

    let caught: unknown;
    try {
      await getDocs(query(collection(db, 'posts'), where('visibility', '==', 'private')));
    } catch (e) {
      caught = e;
    }

    const err = caught as {
      remediation?: string;
      denialContext?: {
        repro?: {
          command: string;
          testCase: FirestoreCase;
        };
      };
    };
    expect(err.remediation).toContain('--query');
    expect(err.denialContext?.repro?.testCase.query).toEqual({
      where: [{ field: 'visibility', op: '==', value: 'private' }],
    });
  });
});
