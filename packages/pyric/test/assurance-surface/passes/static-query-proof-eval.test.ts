import { describe, expect, it } from 'bun:test';
import { extractSdkUsage } from '../../../src/assurance-surface/code/usage-index.js';
import { concretizeQueryTarget } from '../../../src/assurance-surface/passes/static-query-proof-args.js';
import { evaluateCandidateArm } from '../../../src/assurance-surface/passes/static-query-proof-eval.js';
import { staticQueryProofPass } from '../../../src/assurance-surface/passes/static-query-proof.js';
import { normalizeDatabaseRootAst } from '../../../src/assurance-surface/passes/static-query-proof-rules.js';
import { parseToAST } from '@pyric/rules/internal';
import { SimulateFirestoreRulesHandler } from '@pyric/rules/internal';

describe('static-query-proof-eval', () => {
  it('downgrades unprovable user rules to heuristic when an unseeded admin fallback rule exists', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read: if request.auth != null && request.auth.token.admin == true;
    }
    match /notes/{noteId} {
      allow list: if request.auth != null && resource.data.ownerId == request.auth.uid;
    }
  }
}`;
    const ast = parseToAST(source)!;
    const simulator = new SimulateFirestoreRulesHandler();

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/notes.ts': `
          import { getAuth } from 'firebase/auth';
          import { collection, getDocs, getFirestore, query, where } from 'firebase/firestore';
          const auth = getAuth();
          const db = getFirestore();
          export async function run() {
            await getDocs(collection(db, 'notes'));
            await getDocs(query(collection(db, 'notes'), where('ownerId', '==', auth.currentUser!.uid)));
          }
        `,
      },
    });

    const target = concretizeQueryTarget(usage.refs[0]!)!;
    const unfilteredFailure = evaluateCandidateArm(
      simulator,
      { source, file: 'firestore.rules', ast },
      target,
      [],
    );
    expect(unfilteredFailure?.certainty).toBe('heuristic');
    expect(unfilteredFailure?.remediation).toContain(".where('ownerId', '==', currentUser.uid)");

    const filteredFailure = evaluateCandidateArm(
      simulator,
      { source, file: 'firestore.rules', ast },
      target,
      usage.queries[0]!.constraints,
    );
    expect(filteredFailure).toBeNull();
  });

  it('proves array-contains membership rules and emits array-contains remediation when unfiltered', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      allow list: if request.auth != null && request.auth.uid in resource.data.memberIds;
    }
  }
}`;
    const ast = parseToAST(source)!;
    const simulator = new SimulateFirestoreRulesHandler();

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/rooms.ts': `
          import { getAuth } from 'firebase/auth';
          import { collection, getDocs, getFirestore, query, where } from 'firebase/firestore';
          const auth = getAuth();
          const db = getFirestore();
          export async function run() {
            await getDocs(query(collection(db, 'rooms'), where('memberIds', 'array-contains', auth.currentUser!.uid)));
          }
        `,
      },
    });

    const target = concretizeQueryTarget(usage.queries[0]!.baseRef)!;
    const missingFilter = evaluateCandidateArm(
      simulator,
      { source, file: 'firestore.rules', ast },
      target,
      [],
    );
    expect(missingFilter?.certainty).toBe('static-proof');
    expect(missingFilter?.remediation).toContain(
      ".where('memberIds', 'array-contains', currentUser.uid)",
    );

    const satisfiedFilter = evaluateCandidateArm(
      simulator,
      { source, file: 'firestore.rules', ast },
      target,
      usage.queries[0]!.constraints,
    );
    expect(satisfiedFilter).toBeNull();
  });

  it('downgrades unsupported-predicate prover abstentions on nested fields to heuristic certainty', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow list: if resource.data.meta.ownerId == request.auth.uid;
    }
  }
}`;
    const ast = parseToAST(source)!;
    const simulator = new SimulateFirestoreRulesHandler();

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/nested.ts': `
          import { getAuth } from 'firebase/auth';
          import { FieldPath, collection, getDocs, getFirestore, query, where } from 'firebase/firestore';
          const auth = getAuth();
          const db = getFirestore();
          export async function run() {
            await getDocs(query(collection(db, 'items'), where('meta.ownerId', '==', auth.currentUser!.uid)));
            await getDocs(query(collection(db, 'items'), where(new FieldPath('meta', 'ownerId'), '==', auth.currentUser!.uid)));
          }
        `,
      },
    });

    for (const q of usage.queries) {
      const target = concretizeQueryTarget(q.baseRef)!;
      const failure = evaluateCandidateArm(
        simulator,
        { source, file: 'firestore.rules', ast },
        target,
        q.constraints,
      );
      expect(failure?.certainty).toBe('heuristic');
    }
  });

  it('flags violated or omitted request.query.limit even when rules wrap auth.uid in helpers or read unseeded context', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function currentUid() {
      return request.auth.uid;
    }
    match /helperDocs/{docId} {
      allow list: if request.auth != null
        && resource.data.ownerId == currentUid()
        && request.query.limit <= 10;
    }
    match /verifiedDocs/{docId} {
      allow list: if request.auth != null
        && request.auth.token.email_verified == true
        && resource.data.ownerId == request.auth.uid
        && request.query.limit <= 10;
    }
    match /lookupDocs/{docId} {
      allow list: if request.auth != null
        && exists(/databases/$(database)/documents/staff/$(request.auth.uid))
        && request.query.limit <= 10;
    }
  }
}`;
    const ast = parseToAST(source)!;
    const simulator = new SimulateFirestoreRulesHandler();
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/queries.ts': `
          import { getAuth } from 'firebase/auth';
          import { collection, getDocs, getFirestore, limit, query, where } from 'firebase/firestore';
          const auth = getAuth();
          const db = getFirestore();
          export async function run() {
            await getDocs(query(collection(db, 'helperDocs'), where('ownerId', '==', auth.currentUser!.uid), limit(50)));
            await getDocs(query(collection(db, 'verifiedDocs'), where('ownerId', '==', auth.currentUser!.uid)));
            await getDocs(query(collection(db, 'lookupDocs'), limit(25)));
            await getDocs(query(collection(db, 'verifiedDocs'), where('ownerId', '==', auth.currentUser!.uid), limit(5)));
            await getDocs(query(collection(db, 'lookupDocs'), limit(5)));
          }
        `,
      },
    });

    const evalAt = (idx: number) => {
      const q = usage.queries[idx]!;
      const target = concretizeQueryTarget(q.baseRef)!;
      return evaluateCandidateArm(simulator, { source, file: 'firestore.rules', ast }, target, q.constraints);
    };

    const helperOverLimit = evalAt(0);
    expect(helperOverLimit?.kind).toBe('query-clause-denied');
    expect(helperOverLimit?.certainty).toBe('static-proof');

    const verifiedMissingLimit = evalAt(1);
    expect(verifiedMissingLimit?.kind).toBe('query-clause-denied');
    expect(verifiedMissingLimit?.certainty).toBe('static-proof');

    const lookupOverLimit = evalAt(2);
    expect(lookupOverLimit?.kind).toBe('query-clause-denied');
    expect(lookupOverLimit?.certainty).toBe('static-proof');

    expect(evalAt(3)).toBeNull();
    expect(evalAt(4)).toBeNull();
  });

  it('binds {database} wildcard to target databaseId and rejects cross-database DocumentReference filters', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /secondaryItems/{id} {
      allow list: if database == 'secondary';
    }
    match /defaultOnlyItems/{id} {
      allow list: if database == '(default)';
    }
    match /scopedItems/{id} {
      allow list: if resource.data.orgRef == /databases/$(database)/documents/orgs/o1;
    }
  }
}`;
    const rawAst = parseToAST(source)!;
    const simulator = new SimulateFirestoreRulesHandler();
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/multi-db.ts': `
          import { collection, doc, getDocs, getFirestore, query, where } from 'firebase/firestore';
          const defaultDb = getFirestore();
          const secondaryDb = getFirestore('secondary');
          export async function run() {
            await getDocs(collection(secondaryDb, 'secondaryItems'));
            await getDocs(collection(secondaryDb, 'defaultOnlyItems'));
            await getDocs(query(collection(secondaryDb, 'scopedItems'), where('orgRef', '==', doc(secondaryDb, 'orgs', 'o1'))));
            await getDocs(query(collection(secondaryDb, 'scopedItems'), where('orgRef', '==', doc(defaultDb, 'orgs', 'o1'))));
            await getDocs(query(collection(defaultDb, 'scopedItems'), where('orgRef', '==', doc(secondaryDb, 'orgs', 'o1'))));
          }
        `,
      },
    });

    const secondaryAst = normalizeDatabaseRootAst(rawAst, 'secondary');

    const secondaryTarget = concretizeQueryTarget(usage.refs.find((r) => r.id.includes('secondaryItems'))!)!;
    expect(
      evaluateCandidateArm(
        simulator,
        { source, file: 'firestore.rules', ast: secondaryAst, resourceId: 'secondary' },
        secondaryTarget,
        [],
      ),
    ).toBeNull();

    const defaultOnlyTarget = concretizeQueryTarget(usage.refs.find((r) => r.id.includes('defaultOnlyItems'))!)!;
    const defaultOnlyFailure = evaluateCandidateArm(
      simulator,
      { source, file: 'firestore.rules', ast: secondaryAst, resourceId: 'secondary' },
      defaultOnlyTarget,
      [],
    );
    expect(defaultOnlyFailure?.kind).toBe('always-denied');
    expect(defaultOnlyFailure?.certainty).toBe('static-proof');

    const evalScoped = (idx: number, resourceId: string) => {
      const q = usage.queries[idx]!;
      const target = concretizeQueryTarget(q.baseRef)!;
      const ast = normalizeDatabaseRootAst(rawAst, resourceId);
      return evaluateCandidateArm(
        simulator,
        { source, file: 'firestore.rules', ast, resourceId },
        target,
        q.constraints,
      );
    };

    expect(evalScoped(0, 'secondary')).toBeNull();
    const defaultRefOnSecondary = evalScoped(1, 'secondary');
    expect(defaultRefOnSecondary?.kind).toBe('constraints-not-satisfied');
    expect(defaultRefOnSecondary?.certainty).toBe('static-proof');

    const secondaryRefOnDefault = evalScoped(2, '(default)');
    expect(secondaryRefOnDefault?.kind).toBe('constraints-not-satisfied');
    expect(secondaryRefOnDefault?.certainty).toBe('static-proof');
  });

  it('distinguishes documentId() from resource.data.__name__ and single-segment literal-dot FieldPath from nested fields', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;
    }
    match /nameDataItems/{id} {
      allow list: if request.auth != null && resource.data.__name__ == request.auth.uid;
    }
    match /dottedItems/{id} {
      allow list: if request.auth != null && resource.data['a.b'] == request.auth.uid;
    }
    match /nestedItems/{id} {
      allow list: if request.auth != null && resource.data.a.b == request.auth.uid;
    }
  }
}`;
    const ast = parseToAST(source)!;
    const simulator = new SimulateFirestoreRulesHandler();
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/fp.ts': `
          import { getAuth } from 'firebase/auth';
          import { FieldPath, collection, doc, documentId, getDocs, getFirestore, query, where } from 'firebase/firestore';
          const auth = getAuth();
          const db = getFirestore();
          export async function run() {
            const uid = auth.currentUser!.uid;
            await getDocs(query(collection(db, 'users'), where(documentId(), '==', uid)));
            await getDocs(query(collection(db, 'users'), where(documentId(), '==', doc(db, 'users', uid))));
            await getDocs(query(collection(db, 'nameDataItems'), where(documentId(), '==', uid)));
            await getDocs(query(collection(db, 'dottedItems'), where(new FieldPath('a.b'), '==', uid)));
            await getDocs(query(collection(db, 'nestedItems'), where(new FieldPath('a.b'), '==', uid)));
          }
        `,
      },
    });

    const evalIdx = (idx: number) => {
      const q = usage.queries[idx]!;
      const target = concretizeQueryTarget(q.baseRef)!;
      return evaluateCandidateArm(simulator, { source, file: 'firestore.rules', ast }, target, q.constraints);
    };

    expect(evalIdx(0)?.certainty).toBe('heuristic');
    expect(evalIdx(1)?.certainty).toBe('heuristic');
    expect(evalIdx(2)?.certainty).toBe('static-proof');
    expect(evalIdx(3)?.certainty).toBe('heuristic');
    expect(evalIdx(4)?.certainty).toBe('static-proof');
  });

  it('handles boolean-wrapped unseeded rules, >500-node helper trees, literal {uid} paths, and !(request.auth != null)', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function leaf() {
      return exists(/databases/$(database)/documents/orgs/acme)
        || exists(/databases/$(database)/documents/orgs/b1)
        || exists(/databases/$(database)/documents/orgs/b2)
        || exists(/databases/$(database)/documents/orgs/b3)
        || exists(/databases/$(database)/documents/orgs/b4);
    }
    function mid() {
      return leaf() && leaf() && leaf() && leaf() && leaf();
    }
    function top() {
      return mid() && mid() && mid() && mid() && mid();
    }
    match /eqBoolWrap/{id} {
      allow list: if (request.auth.token.email_verified == true && request.query.limit <= 10) == true;
    }
    match /limitVsLookup/{id} {
      allow list: if request.query.limit <= get(/databases/$(database)/documents/orgs/cfg).data.max;
    }
    match /largeHelper/{id} {
      allow list: if top() && request.query.limit <= 10;
    }
    match /litUidUnseeded/{uid}/items/{id} {
      allow list: if request.auth != null
        && request.auth.uid == uid
        && request.auth.token.email_verified == true;
    }
    match /negAuthNull/{id} {
      allow list: if !(request.auth != null)
        && exists(/databases/$(database)/documents/orgs/publicCfg);
    }
  }
}`;
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/possibility-edges.ts': `
          import { collection, getDocs, getFirestore, limit, query } from 'firebase/firestore';
          const db = getFirestore();
          export async function run() {
            await getDocs(query(collection(db, 'eqBoolWrap'), limit(100)));
            await getDocs(collection(db, 'limitVsLookup'));
            await getDocs(query(collection(db, 'largeHelper'), limit(100)));
            await getDocs(query(collection(db, 'largeHelper'), limit(5)));
            await getDocs(collection(db, 'litUidUnseeded', 'u-alice', 'items'));
            await getDocs(collection(db, 'negAuthNull'));
          }
        `,
      },
      includeReads: true,
    });

    const diags = staticQueryProofPass(usage, { rules: { '(default)': source } });
    const staticProofLines = diags
      .filter((d) => d.certainty === 'static-proof')
      .map((d) => d.codeSite?.source);
    expect(staticProofLines).toEqual([
      'src/possibility-edges.ts:5',
      'src/possibility-edges.ts:6',
      'src/possibility-edges.ts:7',
    ]);
  });

  it('supports FieldPath backticks/backslashes, orderBy(new FieldPath("a.b")), and documentId() range/inequality filters', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /backtickItems/{id} {
      allow list: if resource.data['a\`b'] == 'v';
    }
    match /backslashItems/{id} {
      allow list: if resource.data['a\\\\b'] == 'v';
    }
    match /dotOrder/{id} {
      allow list: if request.query.orderBy['a.b'] == 'DESC';
    }
    match /gtM/{id} {
      allow read: if id > 'm';
    }
  }
}`;
    const ast = parseToAST(source)!;
    const simulator = new SimulateFirestoreRulesHandler();
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/fp-edges.ts': `
          import { FieldPath, collection, documentId, getDocs, getFirestore, orderBy, query, where } from 'firebase/firestore';
          const db = getFirestore();
          export async function run() {
            await getDocs(query(collection(db, 'backtickItems'), where(new FieldPath('a\`b'), '==', 'v')));
            await getDocs(query(collection(db, 'backslashItems'), where(new FieldPath('a\\\\b'), '==', 'v')));
            await getDocs(query(collection(db, 'dotOrder'), orderBy(new FieldPath('a.b'), 'desc')));
            await getDocs(query(collection(db, 'gtM'), where(documentId(), '>', 'm')));
            await getDocs(query(collection(db, 'gtM'), where(documentId(), '!=', '__listPlaceholder__')));
            await getDocs(query(collection(db, 'gtM'), where(documentId(), 'not-in', ['__listPlaceholder__'])));
            await getDocs(query(collection(db, 'gtM'), where(documentId(), '<', 'm')));
          }
        `,
      },
      includeReads: true,
    });

    const evalIdx = (idx: number) => {
      const q = usage.queries[idx]!;
      const target = concretizeQueryTarget(q.baseRef)!;
      return evaluateCandidateArm(
        simulator,
        { source, file: 'firestore.rules', ast },
        target,
        q.constraints,
      );
    };

    expect(evalIdx(0)).toBeNull();
    expect(evalIdx(1)).toBeNull();
    expect(evalIdx(2)).toBeNull();
    expect(evalIdx(3)?.certainty).toBe('heuristic');
    expect(evalIdx(4)?.certainty).toBe('heuristic');
    expect(evalIdx(5)?.certainty).toBe('heuristic');
    expect(evalIdx(6)?.certainty).toBe('static-proof');
  });
});
