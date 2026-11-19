import type { QueryConstraint } from 'firebase/firestore';
import type { Probe } from '../../rigs/types.ts';
import type { OracleRulesTarget } from '../../src/oracle-rules-session.ts';

const FIREBASE_MANAGEMENT_SCOPE = 'https://www.googleapis.com/auth/firebase';
const FIRESTORE_REAL_LOCK = '/tmp/pyric-firestore-real.lock';

export interface QueryProofReadRulesSubject {
  readonly clientUid: string;
  readDocOutcome(relPath: string, authed: boolean): Promise<string>;
  queryIdsOrError(
    relCollection: string,
    options: {
      authed: boolean;
      whereEqual?: { field: string; value: unknown };
      limitCount?: number;
    },
  ): Promise<{ ok: true; ids: string[] } | { ok: false; code: string }>;
  countOrError(
    relCollection: string,
    options: {
      authed: boolean;
      whereEqual?: { field: string; value: unknown };
    },
  ): Promise<{ ok: true; count: number } | { ok: false; code: string }>;
  firstSnapshotIdsOrError(
    relCollection: string,
    whereEqual?: { field: string; value: unknown },
  ): Promise<{ ok: true; ids: string[] } | { ok: false; code: string }>;
}

export function buildQueryProofRulesBlock(runId: string): string {
  return `      // @pyric/oracle-query-proof-${runId}
      match /__pyric_fs_probe/${runId} {
        match /__ready/{id} {
          allow read, write: if true;
        }
        match /denied_items/{id} {
          allow read, write: if false;
        }
        match /authed_items/{id} {
          allow read: if request.auth != null;
        }
        match /visibility_items/{id} {
          allow get: if false;
          allow list: if resource.data.visibility == 'public'
            || (request.auth != null && resource.data.owner == request.auth.uid);
        }
        match /limited_items/{id} {
          allow list: if request.auth != null && request.query.limit <= 2;
        }
      }`;
}

export function seedDataForQueryProof(clientUid: string): Record<string, Record<string, unknown>> {
  return {
    '__ready/check': { ok: true },
    'denied_items/a': { label: 'secret' },
    'authed_items/a': { label: 'member-only' },
    'visibility_items/pub1': { visibility: 'public', owner: 'other', seq: 1 },
    'visibility_items/pub2': { visibility: 'public', owner: 'other', seq: 2 },
    'visibility_items/mine': { visibility: 'private', owner: clientUid, seq: 3 },
    'visibility_items/theirs': { visibility: 'private', owner: 'other', seq: 4 },
    'limited_items/i1': { seq: 1 },
    'limited_items/i2': { seq: 2 },
    'limited_items/i3': { seq: 3 },
  };
}

export async function observeFirestoreQueryProofAndReadRules(
  subject: QueryProofReadRulesSubject,
): Promise<Record<string, unknown>> {
  const denyAllGetDocs = await subject.queryIdsOrError('denied_items', { authed: true });
  const denyAllCount = await subject.countOrError('denied_items', { authed: true });
  const unauthedGetDocs = await subject.queryIdsOrError('authed_items', { authed: false });
  const authedGetDocs = await subject.queryIdsOrError('authed_items', { authed: true });

  const unfilteredVisibilityList = await subject.queryIdsOrError('visibility_items', { authed: true });
  const provablePublicList = await subject.queryIdsOrError('visibility_items', {
    authed: true,
    whereEqual: { field: 'visibility', value: 'public' },
  });
  const perDocGetOnPublicItem = await subject.readDocOutcome('visibility_items/pub1', true);
  const provablePublicCount = await subject.countOrError('visibility_items', {
    authed: true,
    whereEqual: { field: 'visibility', value: 'public' },
  });
  const unfilteredVisibilityCount = await subject.countOrError('visibility_items', { authed: true });
  const provableOwnerList = await subject.queryIdsOrError('visibility_items', {
    authed: true,
    whereEqual: { field: 'owner', value: subject.clientUid },
  });

  const provableSnapshot = await subject.firstSnapshotIdsOrError('visibility_items', {
    field: 'visibility',
    value: 'public',
  });
  const unprovableSnapshot = await subject.firstSnapshotIdsOrError('visibility_items');

  const limitTwo = await subject.queryIdsOrError('limited_items', { authed: true, limitCount: 2 });
  const limitThree = await subject.queryIdsOrError('limited_items', { authed: true, limitCount: 3 });
  const unlimitedList = await subject.queryIdsOrError('limited_items', { authed: true });

  let limitTwoCount = -1;
  if (limitTwo.ok) {
    limitTwoCount = limitTwo.ids.length;
  }

  return {
    denyAllGetDocs,
    denyAllCount,
    unauthedGetDocs,
    authedGetDocs,
    unfilteredVisibilityList,
    provablePublicList,
    perDocGetOnPublicItem,
    provablePublicCount,
    unfilteredVisibilityCount,
    provableOwnerList,
    provableSnapshot,
    unprovableSnapshot,
    limitTwoOk: limitTwo.ok,
    limitTwoCount,
    limitThree,
    unlimitedList,
  };
}

function errorCodeOf(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const raw = (err as { code?: unknown }).code;
    if (typeof raw === 'string') return raw;
  }
  return 'unknown';
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'Query-proof and security-rules read enforcement on getDocs, getCountFromServer, and onSnapshot: deny-all and auth-gated queries reject with permission-denied, doc-data-dependent list rules require provable where() equalities rather than filtering results, allow get: false does not block provable list queries, and request.query.limit bounds list authorization.',
  async observe() {
    const [
      { deleteApp, initializeApp },
      { deleteUser, getAuth },
      { signInOracleClientAuth },
      fsSdk,
      adminAppMod,
      { getFirestore: getAdminFirestore },
      { loadOracleServiceAccount, oracleAccessToken, oracleAppOptions },
      { OracleRulesSession, runWithOracleRulesRestored },
      { installOracleSignalRestoreGuard },
      { resolveProbeWebConfig },
      { acquireRunLock },
    ] = await Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
      import('../../src/oracle-run-auth-session.ts'),
      import('firebase/firestore'),
      import('firebase-admin/app'),
      import('firebase-admin/firestore'),
      import('../../src/oracle-credential.ts'),
      import('../../src/oracle-rules-session.ts'),
      import('../../src/oracle-signal-restore.ts'),
      import('../../src/sdk-probe-runtime.ts'),
      import('../../src/storage-stdlib-real-lock.ts'),
    ]);

    const sa = await loadOracleServiceAccount();
    const webConfig = await resolveProbeWebConfig(sa);
    const runId = `qp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const basePath = `__pyric_fs_probe/${runId}`;
    const block = buildQueryProofRulesBlock(runId);
    const target: OracleRulesTarget = {
      service: 'Firestore',
      release: 'cloud.firestore',
      rulesFileName: 'firestore.rules',
      marker: `@pyric/oracle-query-proof-${runId}`,
      freshRules: `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n${block}\n    match /{document=**} { allow read, write: if false; }\n  }\n}\n`,
      insertAfter: /(match\s+\/databases\/\{database\}\/documents\s*\{)/,
      insertAfterDescription: '`match /databases/{database}/documents`',
      block: `\n${block}\n`,
    };

    const releaseLock = acquireRunLock(FIRESTORE_REAL_LOCK);
    const session = new OracleRulesSession({
      projectId: sa.project_id,
      accessToken: () => oracleAccessToken(sa, FIREBASE_MANAGEMENT_SCOPE),
    });
    const detachSignals = installOracleSignalRestoreGuard('[sdk-probes]', () => session.restoreAll());

    const authedApp = initializeApp(webConfig, `sdk-probe-qp-auth-${runId}`);
    const unauthedApp = initializeApp(webConfig, `sdk-probe-qp-anon-${runId}`);
    const authedAuth = getAuth(authedApp);
    const authedDb = fsSdk.getFirestore(authedApp);
    const unauthedDb = fsSdk.getFirestore(unauthedApp);
    const adminApp = adminAppMod.initializeApp(oracleAppOptions(sa), `sdk-probe-qp-admin-${runId}`);
    const adminDb = getAdminFirestore(adminApp);

    try {
      return await runWithOracleRulesRestored(session, async () => {
        await session.deploy(target);
        await signInOracleClientAuth(authedAuth, sa, `sdk-qp-${runId}`);
        const clientUid = authedAuth.currentUser?.uid ?? '';
        if (!clientUid) throw new Error('Expected signed-in clientUid for query-proof probe');

        try {
          for (const [rel, docData] of Object.entries(seedDataForQueryProof(clientUid))) {
            await adminDb.doc(`${basePath}/${rel}`).set(docData);
          }

          const deadline = Date.now() + 90_000;
          let consecutive = 0;
          let round = 0;
          while (consecutive < 5) {
            if (Date.now() > deadline) {
              throw new Error('Timed out waiting for query-proof rules propagation');
            }
            round += 1;
            try {
              await fsSdk.setDoc(fsSdk.doc(authedDb, `${basePath}/__ready/authed`), { round });
              await fsSdk.getDocFromServer(fsSdk.doc(authedDb, `${basePath}/__ready/authed`));
              await fsSdk.setDoc(fsSdk.doc(unauthedDb, `${basePath}/__ready/unauthed`), { round });
              await fsSdk.getDocFromServer(fsSdk.doc(unauthedDb, `${basePath}/__ready/unauthed`));
              consecutive += 1;
            } catch {
              consecutive = 0;
            }
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
          await new Promise((resolve) => setTimeout(resolve, 15_000));

          const dbFor = (authed: boolean) => {
            if (authed) return authedDb;
            return unauthedDb;
          };

          const subject: QueryProofReadRulesSubject = {
            clientUid,
            async readDocOutcome(relPath, authed) {
              try {
                await fsSdk.getDoc(fsSdk.doc(dbFor(authed), `${basePath}/${relPath}`));
                return 'allowed';
              } catch (err) {
                return `error:${errorCodeOf(err)}`;
              }
            },
            async queryIdsOrError(relCollection, opts) {
              try {
                const col = fsSdk.collection(dbFor(opts.authed), `${basePath}/${relCollection}`);
                const constraints: QueryConstraint[] = [];
                if (opts.whereEqual !== undefined) {
                  constraints.push(fsSdk.where(opts.whereEqual.field, '==', opts.whereEqual.value));
                }
                if (opts.limitCount !== undefined) {
                  constraints.push(fsSdk.limit(opts.limitCount));
                }
                const q = fsSdk.query(col, ...constraints);
                const snap = await fsSdk.getDocs(q);
                return { ok: true, ids: snap.docs.map((d) => d.id).sort() };
              } catch (err) {
                return { ok: false, code: errorCodeOf(err) };
              }
            },
            async countOrError(relCollection, opts) {
              try {
                const col = fsSdk.collection(dbFor(opts.authed), `${basePath}/${relCollection}`);
                const constraints: QueryConstraint[] = [];
                if (opts.whereEqual !== undefined) {
                  constraints.push(fsSdk.where(opts.whereEqual.field, '==', opts.whereEqual.value));
                }
                const q = fsSdk.query(col, ...constraints);
                const snap = await fsSdk.getCountFromServer(q);
                return { ok: true, count: snap.data().count };
              } catch (err) {
                return { ok: false, code: errorCodeOf(err) };
              }
            },
            async firstSnapshotIdsOrError(relCollection, whereEqual) {
              const col = fsSdk.collection(authedDb, `${basePath}/${relCollection}`);
              const constraints: QueryConstraint[] = [];
              if (whereEqual !== undefined) {
                constraints.push(fsSdk.where(whereEqual.field, '==', whereEqual.value));
              }
              const q = fsSdk.query(col, ...constraints);
              return new Promise((resolve) => {
                let stop: () => void = () => {};
                stop = fsSdk.onSnapshot(
                  q,
                  (snap) => {
                    stop();
                    resolve({ ok: true, ids: snap.docs.map((d) => d.id).sort() });
                  },
                  (err) => {
                    stop();
                    resolve({ ok: false, code: errorCodeOf(err) });
                  },
                );
              });
            },
          };

          return await observeFirestoreQueryProofAndReadRules(subject);
        } finally {
          if (authedAuth.currentUser) {
            await deleteUser(authedAuth.currentUser).catch(() => undefined);
          }
          await fsSdk.terminate(authedDb).catch(() => undefined);
          await fsSdk.terminate(unauthedDb).catch(() => undefined);
          await deleteApp(authedApp).catch(() => undefined);
          await deleteApp(unauthedApp).catch(() => undefined);
          await adminDb.recursiveDelete(adminDb.doc(basePath)).catch(() => undefined);
          await adminAppMod.deleteApp(adminApp).catch(() => undefined);
        }
      });
    } finally {
      detachSignals();
      releaseLock();
    }
  },
};
