import { describe, expect, it } from 'bun:test';
import { extractSdkUsage } from '../../../src/assurance-surface/code/usage-index.js';
import { concretizeQueryTarget } from '../../../src/assurance-surface/passes/static-query-proof-args.js';
import { evaluateCandidateArm } from '../../../src/assurance-surface/passes/static-query-proof-eval.js';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';

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
});
