import { describe, expect, it } from 'bun:test';
import { extractSdkUsage } from '../../../src/assurance-surface/code/usage-index.js';
import { staticQueryProofPass } from '../../../src/assurance-surface/passes/static-query-proof.js';
import { shouldFailOnDiagnostic } from '../../../src/sandbox/internal/assurance-diagnostic.js';

const OWNER_NOTES_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
    match /notes/{noteId} {
      allow get: if request.auth != null && resource.data.ownerId == request.auth.uid;
      allow list: if request.auth != null && resource.data.ownerId == request.auth.uid;
    }
  }
}`;

describe('staticQueryProofPass', () => {
  it('returns zero diagnostics for valid owner-scoped, literal-scoped, path-scoped, and claim-scoped queries', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{noteId} {
      allow list: if request.auth != null && resource.data.ownerId == request.auth.uid;
    }
    match /users/{uid}/notes/{noteId} {
      allow list: if request.auth != null && request.auth.uid == uid;
    }
    match /articles/{articleId} {
      allow list: if resource.data.published == true;
    }
    match /orgs/{orgId}/items/{itemId} {
      allow list: if request.auth != null && exists(/databases/$(database)/documents/orgs/$(orgId)/members/$(request.auth.uid));
    }
    match /audit/{entryId} {
      allow list: if request.auth != null && request.auth.token.role == 'admin';
    }
    match /tenants/{docId} {
      allow list: if request.auth != null && resource.data.tenantId == request.auth.token.tenantId;
    }
  }
}`;

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/valid.ts': `
          import { getAuth, onAuthStateChanged } from 'firebase/auth';
          import {
            collection,
            doc,
            getDoc,
            getDocs,
            getFirestore,
            query,
            where,
          } from 'firebase/firestore';

          const auth = getAuth();
          const db = getFirestore();

          export function subscribeNotes() {
            onAuthStateChanged(auth, async (user) => {
              if (!user) return;
              const token = await user.getIdTokenResult();
              await getDocs(query(collection(db, 'notes'), where('ownerId', '==', user.uid)));
              await getDocs(query(collection(db, 'notes'), where('ownerId', '==', auth.currentUser?.uid)));
              await getDocs(collection(db, 'users', user.uid, 'notes'));
              await getDocs(query(collection(db, 'articles'), where('published', '==', true)));
              await getDocs(query(collection(db, 'tenants'), where('tenantId', '==', token.claims.tenantId)));
              await getDoc(doc(db, 'notes', 'n1'));
            });
          }

          export async function loadOrgAndAudit(orgId: string, uid: string) {
            await getDocs(collection(db, 'orgs', orgId, 'items'));
            await getDocs(collection(db, 'users', uid, 'notes'));
            await getDocs(collection(db, 'audit'));
          }
        `,
      },
    });

    const diagnostics = staticQueryProofPass(usage, rules);
    expect(diagnostics).toEqual([]);
  });

  it('emits static-proof diagnostics with copy-paste .where(...) remediation for unfiltered queries and bare collection reads', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/broken.ts': `
          import { collection, getDocs, getFirestore, onSnapshot, query } from 'firebase/firestore';
          const db = getFirestore();

          export async function loadAllNotes() {
            await getDocs(query(collection(db, 'notes')));
          }

          export function watchBareCollection() {
            return onSnapshot(collection(db, 'notes'), () => {});
          }
        `,
      },
    });

    const diagnostics = staticQueryProofPass(usage, OWNER_NOTES_RULES);
    expect(diagnostics.length).toBe(2);
    for (const diag of diagnostics) {
      expect(diag.code).toBe('firestore-unprovable-list-query');
      expect(diag.service).toBe('firestore');
      expect(diag.resourceId).toBe('(default)');
      expect(diag.certainty).toBe('static-proof');
      expect(diag.severity).toBe('high');
      expect(diag.ruleSite?.source).toContain('firestore.rules:');
      expect(diag.ruleSite?.expression).toContain('resource.data.ownerId == request.auth.uid');
      expect(diag.remediation).toContain(".where('ownerId', '==', currentUser.uid)");
      expect(diag.remediation).not.toContain('__pyric_');
      expect(shouldFailOnDiagnostic(diag)).toBe(true);
    }
    expect(diagnostics.map((d) => d.codeSite?.source)).toEqual([
      'src/broken.ts:10',
      'src/broken.ts:6',
    ]);
  });

  it('detects mismatched literal filters, conditional unfiltered branches, and unprovable or(...) arms as static-proof', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /articles/{articleId} {
      allow list: if resource.data.published == true;
    }
    match /notes/{noteId} {
      allow list: if request.auth != null && resource.data.ownerId == request.auth.uid;
    }
  }
}`;

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/branches.ts': `
          import { getAuth } from 'firebase/auth';
          import { collection, getDocs, getFirestore, or, query, where } from 'firebase/firestore';

          const auth = getAuth();
          const db = getFirestore();

          export async function loadDrafts() {
            return getDocs(query(collection(db, 'articles'), where('published', '==', false)));
          }

          export async function loadNotesConditional(onlyMine: boolean) {
            const uid = auth.currentUser!.uid;
            let q = query(collection(db, 'notes'));
            if (onlyMine) {
              q = query(q, where('ownerId', '==', uid));
            }
            return getDocs(q);
          }

          export async function loadNotesOr() {
            const uid = auth.currentUser!.uid;
            return getDocs(
              query(
                collection(db, 'notes'),
                or(where('ownerId', '==', uid), where('tag', '==', 'pinned')),
              ),
            );
          }
        `,
      },
    });

    const diagnostics = staticQueryProofPass(usage, rules);
    expect(diagnostics.length).toBe(3);
    expect(diagnostics.every((d) => d.certainty === 'static-proof')).toBe(true);

    const draftDiag = diagnostics.find((d) => d.codeSite?.source === 'src/branches.ts:9');
    expect(draftDiag?.remediation).toContain(".where('published', '==', true)");
  });

  it('proves collectionGroup queries against recursive rules and flags missing collection-group list rules', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{orgId}/entries/{entryId} {
      allow list: if request.auth != null;
    }
    match /{path=**}/tasks/{taskId} {
      allow list: if request.auth != null && resource.data.assigneeId == request.auth.uid;
    }
  }
}`;

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/groups.ts': `
          import { getAuth } from 'firebase/auth';
          import { collectionGroup, getDocs, getFirestore, query, where } from 'firebase/firestore';

          const auth = getAuth();
          const db = getFirestore();

          export async function run() {
            const uid = auth.currentUser!.uid;
            await getDocs(collectionGroup(db, 'entries'));
            await getDocs(collectionGroup(db, 'tasks'));
            await getDocs(query(collectionGroup(db, 'tasks'), where('assigneeId', '==', uid)));
          }
        `,
      },
    });

    const diagnostics = staticQueryProofPass(usage, rules);
    expect(diagnostics.length).toBe(2);
    expect(diagnostics.every((d) => d.certainty === 'static-proof')).toBe(true);

    const entriesDiag = diagnostics.find((d) => d.codeSite?.source === 'src/groups.ts:10');
    expect(entriesDiag?.remediation).toContain('match /{path=**}/entries/{docId}');

    const tasksDiag = diagnostics.find((d) => d.codeSite?.source === 'src/groups.ts:11');
    expect(tasksDiag?.remediation).toContain(".where('assigneeId', '==', currentUser.uid)");
  });

  it('classifies parameterized helpers on required rule fields as heuristic while keeping unrelated params static-proof', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{noteId} {
      allow list: if request.auth != null && resource.data.ownerId == request.auth.uid;
    }
    match /articles/{articleId} {
      allow list: if resource.data.published == true;
    }
    match /projects/{projectId} {
      allow list: if request.auth != null && resource.data.orgId in request.auth.token.orgs;
    }
    match /feed/{itemId} {
      allow list: if request.auth != null && request.query.limit <= 10;
    }
  }
}`;

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/helpers.ts': `
          import { collection, getDocs, getFirestore, limit, query, where } from 'firebase/firestore';
          const db = getFirestore();

          export function listNotesForOwner(ownerId: string) {
            return getDocs(query(collection(db, 'notes'), where('ownerId', '==', ownerId)));
          }

          export function listProjectsForOrg(orgId: string) {
            return getDocs(query(collection(db, 'projects'), where('orgId', '==', orgId)));
          }

          export function listArticlesByCategory(category: string) {
            return getDocs(query(collection(db, 'articles'), where('category', '==', category)));
          }

          export function listFeedPage(pageSize: number) {
            return getDocs(query(collection(db, 'feed'), limit(pageSize)));
          }

          export function listFeedTooLarge() {
            return getDocs(query(collection(db, 'feed'), limit(50)));
          }

          export function listDynamicCollection(colName: string) {
            return getDocs(collection(db, colName));
          }
        `,
      },
    });

    const diagnostics = staticQueryProofPass(usage, rules);

    const ownerHelper = diagnostics.find((d) => d.codeSite?.source === 'src/helpers.ts:6');
    expect(ownerHelper?.certainty).toBe('heuristic');
    expect(ownerHelper?.severity).toBe('medium');
    expect(shouldFailOnDiagnostic(ownerHelper!)).toBe(false);

    const orgHelper = diagnostics.find((d) => d.codeSite?.source === 'src/helpers.ts:10');
    expect(orgHelper?.certainty).toBe('heuristic');
    expect(shouldFailOnDiagnostic(orgHelper!)).toBe(false);

    const unrelatedParam = diagnostics.find((d) => d.codeSite?.source === 'src/helpers.ts:14');
    expect(unrelatedParam?.certainty).toBe('static-proof');
    expect(unrelatedParam?.severity).toBe('high');
    expect(unrelatedParam?.remediation).toContain(".where('published', '==', true)");

    const dynamicLimit = diagnostics.find((d) => d.codeSite?.source === 'src/helpers.ts:18');
    expect(dynamicLimit?.certainty).toBe('heuristic');

    const staticLimitViolation = diagnostics.find((d) => d.codeSite?.source === 'src/helpers.ts:22');
    expect(staticLimitViolation?.certainty).toBe('static-proof');

    const dynamicCollection = diagnostics.find((d) => d.codeSite?.source === 'src/helpers.ts:26');
    expect(dynamicCollection?.certainty).toBe('heuristic');
  });

  it('scopes rules per Firestore databaseId and runs cleanly when globalThis.process is undefined', () => {
    const defaultRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /events/{eventId} {
      allow list: if resource.data.public == true;
    }
  }
}`;
    const analyticsRules = `rules_version = '2';
service cloud.firestore {
  match /databases/analytics/documents {
    match /events/{eventId} {
      allow get: if request.auth != null;
    }
  }
}`;

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/multi.ts': `
          import { initializeApp } from 'firebase/app';
          import { collection, getDocs, getFirestore, query, where } from 'firebase/firestore';

          const app = initializeApp({});
          const defaultDb = getFirestore(app);
          const analyticsDb = getFirestore(app, 'analytics');

          export async function run() {
            await getDocs(query(collection(defaultDb, 'events'), where('public', '==', true)));
            await getDocs(collection(analyticsDb, 'events'));
          }
        `,
      },
    });

    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');
    Object.defineProperty(globalThis, 'process', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    let diagnostics: ReturnType<typeof staticQueryProofPass>;
    try {
      diagnostics = staticQueryProofPass(usage, {
        rules: {
          '(default)': defaultRules,
          analytics: analyticsRules,
        },
        rulesFile: {
          '(default)': 'firestore.rules',
          analytics: 'analytics.rules',
        },
      });
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, 'process', descriptor);
      }
    }

    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0]!.resourceId).toBe('analytics');
    expect(diagnostics[0]!.certainty).toBe('static-proof');
    expect(diagnostics[0]!.ruleSite?.source).toBe('analytics.rules');
    expect(diagnostics[0]!.remediation).toContain('allow list');
  });

  it('checks standalone exported queries and aggregate reads while ignoring write-only collection refs', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/standalone.ts': `
          import {
            addDoc,
            collection,
            getCountFromServer,
            getFirestore,
            query,
          } from 'firebase/firestore';

          const db = getFirestore();
          export const notesCol = collection(db, 'notes');
          export const exportedAllNotesQuery = query(notesCol);

          export async function createAndCount() {
            await addDoc(notesCol, { ownerId: 'u1', text: 'hello' });
            await getCountFromServer(collection(db, 'notes'));
          }
        `,
      },
    });

    const diagnostics = staticQueryProofPass(usage, OWNER_NOTES_RULES);
    expect(diagnostics.length).toBe(2);
    expect(diagnostics.every((d) => d.certainty === 'static-proof')).toBe(true);
    expect(diagnostics.map((d) => d.codeSite?.source)).toEqual([
      'src/standalone.ts:12',
      'src/standalone.ts:16',
    ]);
  });

  it('skips Admin SDK Firestore queries without emitting false positives', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/admin-report.ts': `
          import { getAdminFirestore, collection, query, getDocs } from 'pyric-admin/firestore';

          const adminDb = getAdminFirestore();
          export const adminAllNotes = query(collection(adminDb, 'notes'));

          export async function listAllNotesAsAdmin() {
            return getDocs(collection(adminDb, 'notes'));
          }
        `,
      },
    });

    expect(usage.queries.every((q) => q.admin === true && q.baseRef.admin === true)).toBe(true);
    expect(staticQueryProofPass(usage, OWNER_NOTES_RULES)).toEqual([]);
  });

  it('evaluates named Firestore databases against shared default rules while isolating (default) root blocks', () => {
    const sharedExplicitMultiDb = `rules_version = '2';
service cloud.firestore {
  match /databases/(default)/documents {
    match /events/{id} {
      allow read: if true;
    }
  }
  match /databases/analytics/documents {
    match /events/{id} {
      allow list: if resource.data.ownerId == request.auth.uid;
    }
  }
}`;
    const sharedWildcardDb = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /events/{id} {
      allow list: if resource.data.ownerId == request.auth.uid;
    }
  }
}`;
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/analytics.ts': `
          import { initializeApp } from 'firebase/app';
          import { collection, getDocs, getFirestore } from 'firebase/firestore';
          const db = getFirestore(initializeApp({ projectId: 'proj-1' }), 'analytics');
          export const loadEvents = () => getDocs(collection(db, 'events'));
        `,
      },
    });

    const explicitDiags = staticQueryProofPass(usage, {
      rules: { '(default)': sharedExplicitMultiDb },
      rulesFile: { '(default)': 'firestore.rules' },
      sharedDefaultRules: true,
    });
    expect(explicitDiags).toHaveLength(1);
    expect(explicitDiags[0]?.resourceId).toBe('analytics');
    expect(explicitDiags[0]?.certainty).toBe('static-proof');

    const wildcardDiags = staticQueryProofPass(usage, {
      rules: { '(default)': sharedWildcardDb },
      rulesFile: { '(default)': 'firestore.rules' },
      sharedDefaultRules: true,
    });
    expect(wildcardDiags).toHaveLength(1);
    expect(wildcardDiags[0]?.resourceId).toBe('analytics');
    expect(wildcardDiags[0]?.certainty).toBe('static-proof');
  });

  it('projects multiple orderBy clauses into request.query.orderBy and downgrades dynamic orderBy fields to heuristic', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow list: if request.query.orderBy.priority == 'DESC' && request.query.orderBy.createdAt == 'DESC';
    }
    match /docs/{docId} {
      allow list: if request.query.orderBy.updatedAt == 'DESC';
    }
  }
}`;
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/queries.ts': `
          import { collection, getDocs, getFirestore, orderBy, query } from 'firebase/firestore';
          declare function pickSortField(): string;
          const db = getFirestore();

          export async function loadValidMultiOrder() {
            return getDocs(query(collection(db, 'items'), orderBy('priority', 'desc'), orderBy('createdAt', 'desc')));
          }

          export async function loadWrongMultiOrder() {
            return getDocs(query(collection(db, 'items'), orderBy('priority', 'asc'), orderBy('createdAt', 'desc')));
          }

          export async function loadDynamicOrder() {
            return getDocs(query(collection(db, 'docs'), orderBy(pickSortField(), 'desc')));
          }
        `,
      },
    });

    const diagnostics = staticQueryProofPass(usage, rules);
    expect(diagnostics.filter((d) => d.codeSite?.source === 'src/queries.ts:7')).toEqual([]);

    const wrongDiag = diagnostics.find((d) => d.codeSite?.source === 'src/queries.ts:11');
    expect(wrongDiag?.certainty).toBe('static-proof');

    const dynamicDiag = diagnostics.find((d) => d.codeSite?.source === 'src/queries.ts:15');
    expect(dynamicDiag?.certainty).toBe('heuristic');
  });

  it('proves typed wrapper scalar constraints, downgrades dynamic wrapper refs to heuristic, and formats client SDK remediations without raw wrapper blobs', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /projects/{projectId} {
      allow list: if resource.data.orgRef == /databases/$(database)/documents/orgs/acme;
    }
    match /profiles/{profileId} {
      allow list: if request.auth != null && resource.data.userRef == /databases/$(database)/documents/users/$(request.auth.uid);
    }
    match /snapshots/{snapId} {
      allow list: if resource.data.publishedAt == timestamp.date(2026, 1, 1);
    }
    match /packets/{pktId} {
      allow list: if resource.data.header == b'\\x01\\x02';
    }
    match /beacons/{beaconId} {
      allow list: if resource.data.coords == latlng.value(37.5, -122.0);
    }
  }
}`;

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/wrappers.ts': `
          import { getAuth } from 'firebase/auth';
          import {
            Bytes,
            GeoPoint,
            Timestamp,
            collection,
            doc,
            getDocs,
            getFirestore,
            query,
            where,
          } from 'firebase/firestore';

          const auth = getAuth();
          const db = getFirestore();

          export async function runValidWrappers() {
            const uid = auth.currentUser!.uid;
            await getDocs(query(collection(db, 'projects'), where('orgRef', '==', doc(db, 'orgs', 'acme'))));
            await getDocs(query(collection(db, 'profiles'), where('userRef', '==', doc(db, 'users', uid))));
            await getDocs(query(collection(db, 'snapshots'), where('publishedAt', '==', Timestamp.fromDate(new Date('2026-01-01T00:00:00.000Z')))));
            await getDocs(query(collection(db, 'packets'), where('header', '==', Bytes.fromUint8Array(new Uint8Array([1, 2])))));
            await getDocs(query(collection(db, 'beacons'), where('coords', '==', new GeoPoint(37.5, -122.0))));
          }

          export async function runMismatchedOrgRef() {
            return getDocs(query(collection(db, 'projects'), where('orgRef', '==', doc(db, 'orgs', 'other'))));
          }

          export async function runUnfilteredProfiles() {
            return getDocs(collection(db, 'profiles'));
          }

          export async function runDynamicOrgRef(orgId: string) {
            return getDocs(query(collection(db, 'projects'), where('orgRef', '==', doc(db, 'orgs', orgId))));
          }
        `,
      },
    });

    const diagnostics = staticQueryProofPass(usage, rules);
    expect(diagnostics).toHaveLength(3);

    const mismatchDiag = diagnostics.find((d) => d.codeSite?.source === 'src/wrappers.ts:28');
    expect(mismatchDiag?.certainty).toBe('static-proof');
    expect(mismatchDiag?.remediation).toContain("doc(db, 'orgs', 'acme')");
    expect(mismatchDiag?.remediation).not.toContain('__type');
    expect(mismatchDiag?.remediation).not.toContain('__pyric_');

    const unfilteredProfileDiag = diagnostics.find((d) => d.codeSite?.source === 'src/wrappers.ts:32');
    expect(unfilteredProfileDiag?.certainty).toBe('static-proof');
    expect(unfilteredProfileDiag?.remediation).toContain("doc(db, 'users', currentUser.uid)");
    expect(unfilteredProfileDiag?.remediation).not.toContain('__type');
    expect(unfilteredProfileDiag?.remediation).not.toContain('__pyric_synth_uid__');

    const dynamicOrgRefDiag = diagnostics.find((d) => d.codeSite?.source === 'src/wrappers.ts:36');
    expect(dynamicOrgRefDiag?.certainty).toBe('heuristic');
    expect(shouldFailOnDiagnostic(dynamicOrgRefDiag!)).toBe(false);
  });

  it('projects path-invariant branches of mixed collection-group || disjunctions and enforces OrBudgetStep lookup budgets', () => {
    const mixedRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{path=**}/comments/{id} {
      allow list: if id == 'pinned' || resource.data.public == true;
    }
  }
}`;
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/cg.ts': `
          import { collectionGroup, getDocs, getFirestore, query, where } from 'firebase/firestore';
          const db = getFirestore();

          export async function loadPublicComments() {
            return getDocs(query(collectionGroup(db, 'comments'), where('public', '==', true)));
          }

          export async function loadAllComments() {
            return getDocs(collectionGroup(db, 'comments'));
          }
        `,
      },
    });

    const mixedDiags = staticQueryProofPass(usage, mixedRules);
    expect(mixedDiags).toHaveLength(1);
    expect(mixedDiags[0]?.codeSite?.source).toBe('src/cg.ts:10');
    expect(mixedDiags[0]?.certainty).toBe('static-proof');
    expect(mixedDiags[0]?.remediation).toContain(".where('public', '==', true)");
    expect(mixedDiags[0]?.remediation).not.toContain('match /{path=**}/comments');

    const lookupChain = Array.from(
      { length: 11 },
      (_, idx) => `exists(/databases/$(database)/documents/flags/f${idx + 1})`,
    ).join(' || ');
    const overBudgetRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{path=**}/comments/{id} {
      allow list: if (id == 'pinned' && (${lookupChain})) || resource.data.public == true;
    }
  }
}`;
    const publicOnlyUsage = extractSdkUsage({
      root: '/app',
      files: {
        'src/budget.ts': `
          import { collectionGroup, getDocs, getFirestore, query, where } from 'firebase/firestore';
          const db = getFirestore();
          export async function loadPublic() {
            return getDocs(query(collectionGroup(db, 'comments'), where('public', '==', true)));
          }
        `,
      },
    });
    const budgetDiags = staticQueryProofPass(publicOnlyUsage, overBudgetRules);
    expect(budgetDiags).toHaveLength(1);
    expect(budgetDiags[0]?.code).toBe('firestore-unprovable-list-query');

    const innerOrOverBudgetRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function specialComment(docId) {
      return docId == 'pinned' && (${lookupChain});
    }
    match /{path=**}/comments/{id} {
      allow list: if (resource.data.status == 'open' || resource.data.status == 'closed')
        && (specialComment(id) || request.auth != null);
    }
  }
}`;
    const inDomainUsage = extractSdkUsage({
      root: '/app',
      files: {
        'src/inner-budget.ts': `
          import { collectionGroup, getDocs, getFirestore, query, where } from 'firebase/firestore';
          const db = getFirestore();
          export async function loadByStatus() {
            return getDocs(query(collectionGroup(db, 'comments'), where('status', 'in', ['open', 'closed'])));
          }
        `,
      },
    });
    const innerBudgetDiags = staticQueryProofPass(inDomainUsage, innerOrOverBudgetRules, {
      auth: { uid: 'u1' },
    });
    expect(innerBudgetDiags).toHaveLength(1);
    expect(innerBudgetDiags[0]?.code).toBe('firestore-unprovable-list-query');
  });
});
