import { describe, expect, it } from 'bun:test';
import { extractSdkUsage } from '../../../src/assurance-surface/code/usage-index.js';
import {
  concretizeQueryTarget,
  expandQueryArms,
  projectConstraintArm,
  renderClientQueryRemediation,
  SYNTH_UID,
} from '../../../src/assurance-surface/passes/static-query-proof-args.js';

describe('static-query-proof-args', () => {
  it('concretizes auth.uid path variables to SYNTH_UID and non-auth variables to distinct tokens', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/notes.ts': `
          import { getAuth } from 'firebase/auth';
          import { collection, getDocs, getFirestore } from 'firebase/firestore';

          const auth = getAuth();
          const db = getFirestore();

          export async function loadOwnedAndOrg(orgId: string) {
            const uid = auth.currentUser!.uid;
            await getDocs(collection(db, 'users', uid, 'notes'));
            await getDocs(collection(db, 'orgs', orgId, 'items'));
          }
        `,
      },
    });

    const userNotesRef = usage.refs.find((r) => r.id.includes('users/{uid}/notes'));
    const orgItemsRef = usage.refs.find((r) => r.id.includes('orgs/{orgId}/items'));
    expect(userNotesRef).toBeDefined();
    expect(orgItemsRef).toBeDefined();

    const userTarget = concretizeQueryTarget(userNotesRef!);
    expect(userTarget).toEqual({
      isCollectionGroup: false,
      collectionPath: `users/${SYNTH_UID}/notes`,
      renderedPattern: 'users/{uid}/notes',
      hasDynamicSegment: true,
      hasPartialPath: false,
      nonAuthSegmentValues: [],
      literalDocIdValues: [],
    });

    const orgTarget = concretizeQueryTarget(orgItemsRef!);
    expect(orgTarget?.isCollectionGroup).toBe(false);
    expect(orgTarget?.renderedPattern).toBe('orgs/{orgId}/items');
    expect(orgTarget?.hasPartialPath).toBe(false);
    expect(orgTarget?.nonAuthSegmentValues.length).toBe(1);
    expect(orgTarget?.collectionPath).toBe(`orgs/${orgTarget?.nonAuthSegmentValues[0]}/items`);
  });

  it('marks dynamic collection-name segments as partial and skips document refs', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/dyn.ts': `
          import { collection, doc, getDoc, getDocs, getFirestore } from 'firebase/firestore';
          const db = getFirestore();
          export async function run(colName: string) {
            await getDocs(collection(db, colName));
            await getDoc(doc(db, 'notes', 'n1'));
          }
        `,
      },
    });

    const dynCol = usage.refs.find((r) => r.refKind === 'collection');
    const docRef = usage.refs.find((r) => r.refKind === 'doc');
    expect(concretizeQueryTarget(dynCol!)?.hasPartialPath).toBe(true);
    expect(concretizeQueryTarget(docRef!)).toBeNull();
  });

  it('concretizes literal and dynamic collectionGroup targets', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/cg.ts': `
          import { collectionGroup, getDocs, getFirestore } from 'firebase/firestore';
          const db = getFirestore();
          export async function run(dynamicGroup: string) {
            await getDocs(collectionGroup(db, 'entries'));
            await getDocs(collectionGroup(db, dynamicGroup));
          }
        `,
      },
    });

    const groupRefs = usage.refs.filter((r) => r.refKind === 'collectionGroup');
    expect(groupRefs.length).toBe(2);
    const literalGroup = concretizeQueryTarget(groupRefs[0]!);
    expect(literalGroup).toEqual({
      isCollectionGroup: true,
      collectionPath: 'entries',
      renderedPattern: 'entries',
      hasDynamicSegment: false,
      hasPartialPath: false,
      nonAuthSegmentValues: [],
      literalDocIdValues: [],
    });
    const dynamicGroup = concretizeQueryTarget(groupRefs[1]!);
    expect(dynamicGroup?.isCollectionGroup).toBe(true);
    expect(dynamicGroup?.hasPartialPath).toBe(true);
  });

  it('expands conditional branches and composite or/and filters and projects operands', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/q.ts': `
          import { getAuth } from 'firebase/auth';
          import {
            and,
            collection,
            getDocs,
            getFirestore,
            limit,
            or,
            query,
            where,
          } from 'firebase/firestore';

          const auth = getAuth();
          const db = getFirestore();

          export async function load(flag: boolean, extraTag: string) {
            const user = auth.currentUser!;
            const token = await user.getIdTokenResult();
            let q = query(
              collection(db, 'notes'),
              or(
                and(where('ownerId', '==', user.uid), where('tenantId', '==', token.claims.tenantId)),
                where('visibility', 'in', ['public', 'unlisted']),
              ),
              limit(25),
            );
            if (flag) {
              q = query(q, where('tag', '==', extraTag));
            }
            return getDocs(q);
          }
        `,
      },
    });

    expect(usage.queries.length).toBe(1);
    const arms = expandQueryArms(usage.queries[0]!);
    expect(arms.length).toBe(4);

    const ownerArm = arms
      .map(projectConstraintArm)
      .find((p) => p.constraints.where?.some((w) => w.field === 'ownerId'));
    expect(ownerArm).toBeDefined();
    expect(ownerArm!.auth.uid).toBe(SYNTH_UID);
    expect(ownerArm!.auth.token.tenantId).toBe('__pyric_claim_tenantId__');
    expect(ownerArm!.constraints.limit).toBe(25);
    expect(ownerArm!.constraints.where).toEqual([
      { field: 'ownerId', op: '==', value: SYNTH_UID },
      { field: 'tenantId', op: '==', value: '__pyric_claim_tenantId__' },
    ]);

    const taggedArm = arms
      .map(projectConstraintArm)
      .find((p) => p.unresolvedWheres.some((u) => u.field === 'tag'));
    expect(taggedArm).toBeDefined();
    expect(taggedArm!.unresolvedWheres).toEqual([{ field: 'tag', op: '==' }]);
  });

  it('renders copy-paste where(...) remediation without leaking synthetic placeholders', () => {
    const remediation = renderClientQueryRemediation({
      kind: 'constraints-not-satisfied',
      isCollectionGroup: false,
      renderedPattern: 'notes',
      residual: {
        missing: [
          { field: 'ownerId', expectedValue: SYNTH_UID, fromAuthUid: true },
          { field: 'archived', expectedValue: false, fromAuthUid: false },
        ],
        mismatched: [],
      },
    });

    expect(remediation).toContain(".where('ownerId', '==', currentUser.uid)");
    expect(remediation).toContain("where('archived', '==', false)");
    expect(remediation).not.toContain(SYNTH_UID);
    expect(remediation).not.toContain('__pyric_');
  });

  it('defines custom token claims as own properties without mutating Object.prototype on __proto__', () => {
    const projected = projectConstraintArm([
      {
        kind: 'where',
        field: 'role',
        op: '==',
        operand: {
          kind: 'auth',
          auth: [{ source: 'auth.token.__proto__', certainty: 'exact' }],
        },
      },
    ]);
    expect(Object.getPrototypeOf(projected.auth.token)).toBe(Object.prototype);
    expect(Object.hasOwn(projected.auth.token, '__proto__')).toBe(true);
  });
});
