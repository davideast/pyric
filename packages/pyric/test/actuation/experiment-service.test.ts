import { describe, expect, test, beforeEach } from 'bun:test';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import {
  mutateSandboxData,
  dryRunExperiment,
  diagnoseRuleDenial,
  verifySecurityRules,
  switchAuthIdentity,
} from '../../src/actuation/index.js';

describe('Seam 2: Branching & Diagnostics Domain Service (experiment-service)', () => {
  let sandbox: LocalSandbox;

  beforeEach(async () => {
    sandbox = initializeSandbox();
    setRules(
      sandbox,
      `rules_version = '2';
       service cloud.firestore {
         match /databases/{database}/documents {
           match /articles/{articleId} {
             allow read, write: if request.auth != null;
           }
         }
       }`
    );
    // Record a real user write event in sandbox history
    await mutateSandboxData(sandbox, {
      service: 'firestore',
      action: 'set',
      path: 'articles/post1',
      dataJson: JSON.stringify({ title: 'Hello World', authorId: 'alice' }),
      auth: { mode: 'uid', uid: 'alice' },
    });
  });

  test('dryRunExperiment catches rule regressions against recorded traffic and blocks unforced promotion', async () => {
    const forkRes = await dryRunExperiment(sandbox, {
      action: 'fork',
      branchId: 'exp-1',
    });
    expect(forkRes.ok).toBe(true);
    expect(forkRes.status).toBe('forked');

    // Candidate rules tighten write access so only admin role can write
    const tighterRules = `rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /articles/{articleId} {
            allow read: if true;
            allow write: if request.auth != null && request.auth.token.role == 'admin';
          }
        }
      }`;

    const diffRes = await dryRunExperiment(sandbox, {
      action: 'diff',
      branchId: 'exp-1',
      candidateRules: tighterRules,
    });
    expect(diffRes.ok).toBe(true);
    expect(diffRes.regressions.length).toBeGreaterThan(0);
    expect(diffRes.regressions[0]?.path).toBe('articles/post1');
    expect(diffRes.regressions[0]?.previousDecision).toBe('ALLOW');
    expect(diffRes.regressions[0]?.candidateDecision).toBe('DENY');

    // Attempt promote without force -> rejected due to regression
    const promoteBlocked = await dryRunExperiment(sandbox, {
      action: 'promote',
      branchId: 'exp-1',
      candidateRules: tighterRules,
    });
    expect(promoteBlocked.ok).toBe(false);
    expect(promoteBlocked.status).toBe('rejected');

    // Discard branch
    const discardRes = await dryRunExperiment(sandbox, {
      action: 'discard',
      branchId: 'exp-1',
    });
    expect(discardRes.ok).toBe(true);
    expect(discardRes.status).toBe('discarded');
  });

  test('dryRunExperiment promotes clean migrations when no regressions exist', async () => {
    await dryRunExperiment(sandbox, {
      action: 'fork',
      branchId: 'clean-branch',
    });

    const compatibleRules = `rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /articles/{articleId} {
            allow read, write: if request.auth != null;
          }
        }
      }`;

    const promoteRes = await dryRunExperiment(sandbox, {
      action: 'promote',
      branchId: 'clean-branch',
      candidateRules: compatibleRules,
    });
    expect(promoteRes.ok).toBe(true);
    expect(promoteRes.status).toBe('promoted');
    expect(promoteRes.regressions).toHaveLength(0);
  });

  test('diagnoseRuleDenial traces AST expression evaluation step-by-step', async () => {
    const diagRes = await diagnoseRuleDenial(sandbox, {
      service: 'firestore',
      operation: 'create',
      path: 'articles/post2',
      resourceDataJson: JSON.stringify({ title: 'Unauthenticated Draft' }),
      // Unauthenticated request (no auth) -> should be denied because request.auth != null is false
    });
    expect(diagRes.ok).toBe(true);
    expect(diagRes.allowed).toBe(false);
    expect(diagRes.decision).toBe('DENY');
    expect(Array.isArray(diagRes.trace)).toBe(true);
    expect(diagRes.trace.length).toBeGreaterThan(0);
  });

  test('verifySecurityRules lints source and simulates test suites', async () => {
    const lintRes = await verifySecurityRules(sandbox, {
      service: 'firestore',
      action: 'lint',
    });
    expect(lintRes.ok).toBe(true);
    expect(Array.isArray(lintRes.issues)).toBe(true);

    const simRes = await verifySecurityRules(sandbox, {
      service: 'firestore',
      action: 'simulate_suite',
      testCases: [
        {
          expectation: 'ALLOW',
          operation: 'get',
          path: 'articles/post1',
          uid: 'alice',
        },
        {
          expectation: 'DENY',
          operation: 'get',
          path: 'articles/post1',
        },
      ],
    });
    expect(simRes.ok).toBe(true);
    expect(simRes.passed).toBe(2);
    expect(simRes.failed).toBe(0);

    // Verify full-lifecycle tenant & claims propagation in simulate_suite
    const tenantSim = await verifySecurityRules(sandbox, {
      service: 'firestore',
      action: 'simulate_suite',
      source: `rules_version = '2';
        service cloud.firestore {
          match /databases/{database}/documents {
            match /tenants/{tenantId}/docs/{docId} {
              allow read: if request.auth != null
                && request.auth.token.firebase.tenant == tenantId
                && request.auth.token.role == 'editor';
            }
          }
        }`,
      testCases: [
        {
          expectation: 'ALLOW',
          operation: 'get',
          path: 'tenants/acme/docs/d1',
          uid: 'u1',
          tenant: 'acme',
          claims: { role: 'editor' },
        },
        {
          expectation: 'DENY',
          operation: 'get',
          path: 'tenants/acme/docs/d1',
          uid: 'u2',
          tenant: 'other-tenant',
          claims: { role: 'editor' },
        },
      ],
    });
    expect(tenantSim.ok).toBe(true);
    expect(tenantSim.passed).toBe(2);
    expect(tenantSim.failed).toBe(0);
  });

  test('Challenger Bug 1, 2 & 3 regressions: diagnoseRuleDenial active lens fallback, create resource:undefined, and partial update merging', async () => {
    setRules(
      sandbox,
      `rules_version = '2';
       service cloud.firestore {
         match /databases/{database}/documents {
           match /articles/{articleId} {
             allow create: if request.auth != null && request.resource.data.authorId == request.auth.uid;
             allow update: if request.auth != null && request.resource.data.authorId == resource.data.authorId;
           }
         }
       }`
    );

    // Bug 1 in diagnoseRuleDenial: when auth is omitted, falls back to active identity lens
    await switchAuthIdentity(sandbox, { mode: 'uid', uid: 'alice' });
    const createDiag = await diagnoseRuleDenial(sandbox, {
      service: 'firestore',
      operation: 'create',
      path: 'articles/new-post',
      resourceData: { title: 'Draft', authorId: 'alice' },
    });
    expect(createDiag.ok).toBe(true);
    expect(createDiag.allowed).toBe(true);

    // Bug 3 in diagnoseRuleDenial: partial update merges existingDoc into request.resource.data
    // articles/post1 exists with { title: 'Hello World', authorId: 'alice' }
    const updateDiag = await diagnoseRuleDenial(sandbox, {
      service: 'firestore',
      operation: 'update',
      path: 'articles/post1',
      resourceData: { title: 'Updated Title Only' },
    });
    expect(updateDiag.ok).toBe(true);
    expect(updateDiag.allowed).toBe(true);
    expect(updateDiag.decision).toBe('ALLOW');
  });
});
