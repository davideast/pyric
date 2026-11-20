import type { Probe } from '../../rigs/types.ts';
import type { OracleRulesTarget } from '../../src/oracle-rules-session.ts';

const FIREBASE_MANAGEMENT_SCOPE = 'https://www.googleapis.com/auth/firebase';
const FIRESTORE_REAL_LOCK = '/tmp/pyric-firestore-real.lock';

export type ProbeClientKind = 'unauthed' | 'plain' | 'claimed';

export interface RulesWriteAndCrossDocSubject {
  readOutcome(client: ProbeClientKind, relPath: string): Promise<string>;
  setOutcome(client: ProbeClientKind, relPath: string, data: Record<string, unknown>): Promise<string>;
  updateOutcome(client: ProbeClientKind, relPath: string, data: Record<string, unknown>): Promise<string>;
}

export function buildWriteAndCrossDocRulesBlock(runId: string): string {
  const probeDocRoot = `/databases/$(database)/documents/__pyric_fs_probe/${runId}`;
  const aclBase = `${probeDocRoot}/acl`;
  return `      // @pyric/oracle-write-crossdoc-${runId}
      match /__pyric_fs_probe/${runId} {
        match /__ready/{id} {
          allow read, write: if true;
        }
        match /anon_only/{id} {
          allow get: if request.auth == null;
        }
        match /cross_doc/{id} {
          allow get: if exists(${aclBase}/$(id))
            && get(${aclBase}/$(id)).data.enabled == true;
        }
        match /cross_doc_id/{id} {
          allow get: if get(${aclBase}/$(id)).id == id;
        }
        match /cross_doc_id_not_eq/{id} {
          allow get: if get(${aclBase}/$(id)).id != 'zzz';
        }
        match /cross_doc_name/{id} {
          allow get: if get(${aclBase}/$(id)).__name__ == ${aclBase}/$(id);
        }
        match /unguarded_missing_get/{id} {
          allow get: if get(${aclBase}/nonexistent).data.enabled == true;
        }
        match /validated_creates/{id} {
          allow create: if request.resource.data.title is string
            && request.resource.data.title.size() > 0;
        }
        match /owned_updates/{id} {
          allow update: if request.auth != null
            && resource.data.owner == request.auth.uid
            && request.resource.data.owner == resource.data.owner;
        }
        match /claim_gated/{id} {
          allow write: if request.auth != null
            && request.auth.token.role == 'editor'
            && request.auth.token.tier == 2;
        }
        match /merged_updates/{id} {
          allow create, update: if request.resource.data.keep == 'preserved'
            && request.resource.data.step == 2
            && getAfter(${probeDocRoot}/merged_updates/$(id)).data.keep == 'preserved';
        }
      }`;
}

export function seedDataForWriteAndCrossDoc(plainUid: string): Record<string, Record<string, unknown>> {
  return {
    '__ready/check': { ok: true },
    'anon_only/doc1': { publicBanner: true },
    'acl/enabled_doc': { enabled: true },
    'acl/disabled_doc': { enabled: false },
    'cross_doc/enabled_doc': { label: 'allowed' },
    'cross_doc/disabled_doc': { label: 'blocked' },
    'cross_doc/missing_acl': { label: 'no-acl' },
    'cross_doc_id/enabled_doc': { label: 'id-check' },
    'cross_doc_id_not_eq/enabled_doc': { label: 'id-neq-check' },
    'cross_doc_name/enabled_doc': { label: 'name-check' },
    'unguarded_missing_get/doc1': { label: 'errors' },
    'owned_updates/mine': { owner: plainUid, count: 1 },
    'owned_updates/other': { owner: 'someone_else', count: 1 },
    'owned_updates/no_owner_field': { count: 1 },
    'merged_updates/for_update': { keep: 'preserved', step: 1 },
    'merged_updates/for_replace': { keep: 'preserved', step: 1 },
  };
}

export async function observeFirestoreRulesWriteAndCrossDoc(
  subject: RulesWriteAndCrossDocSubject,
  plainUid: string,
): Promise<Record<string, unknown>> {
  return {
    anonOnly: {
      unauthedRead: await subject.readOutcome('unauthed', 'anon_only/doc1'),
      signedInRead: await subject.readOutcome('plain', 'anon_only/doc1'),
    },
    crossDoc: {
      enabledAclRead: await subject.readOutcome('plain', 'cross_doc/enabled_doc'),
      disabledAclRead: await subject.readOutcome('plain', 'cross_doc/disabled_doc'),
      existsGuardMissingAclRead: await subject.readOutcome('plain', 'cross_doc/missing_acl'),
      crossDocIdRead: await subject.readOutcome('plain', 'cross_doc_id/enabled_doc'),
      crossDocIdNotEqZzzRead: await subject.readOutcome('plain', 'cross_doc_id_not_eq/enabled_doc'),
      crossDocNameRead: await subject.readOutcome('plain', 'cross_doc_name/enabled_doc'),
      unguardedMissingGetRead: await subject.readOutcome('plain', 'unguarded_missing_get/doc1'),
    },
    requestResourceValidation: {
      validCreate: await subject.setOutcome('plain', 'validated_creates/valid', { title: 'Hello' }),
      emptyTitleCreate: await subject.setOutcome('plain', 'validated_creates/empty', { title: '' }),
      nonStringTitleCreate: await subject.setOutcome('plain', 'validated_creates/num', { title: 42 }),
      missingTitleFieldCreate: await subject.setOutcome('plain', 'validated_creates/missing', { other: 'x' }),
    },
    existingResourceField: {
      ownerMatchUpdate: await subject.updateOutcome('plain', 'owned_updates/mine', { count: 2 }),
      ownerChangeAttempt: await subject.updateOutcome('plain', 'owned_updates/mine', { owner: 'hijack', count: 3 }),
      ownerMismatchUpdate: await subject.updateOutcome('plain', 'owned_updates/other', { count: 2 }),
      missingOwnerFieldOnExistingDoc: await subject.updateOutcome('plain', 'owned_updates/no_owner_field', {
        owner: plainUid,
        count: 2,
      }),
    },
    customClaims: {
      claimedWrite: await subject.setOutcome('claimed', 'claim_gated/doc1', { edited: true }),
      plainSignedInWrite: await subject.setOutcome('plain', 'claim_gated/doc2', { edited: true }),
      unauthedWrite: await subject.setOutcome('unauthed', 'claim_gated/doc3', { edited: true }),
    },
    updateMergedRequestResource: {
      sparseUpdatePreservingKeep: await subject.updateOutcome('plain', 'merged_updates/for_update', { step: 2 }),
      fullSetDroppingKeep: await subject.setOutcome('plain', 'merged_updates/for_replace', { step: 2 }),
    },
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
  matrixRow: 'firestore#128',
  rowIds: [
    'firestore#128',
    'firestore#129',
    'firestore#130',
    'firestore#131',
    'firestore#132',
    'firestore#137',
    'firestore#RS2',
    'firestore#RS3',
  ],
  description:
    'Firestore security-rules write and cross-document evaluation via the client SDK: request.auth == null when unauthenticated, cross-document exists()/get() and get(path).id/__name__ with missing-doc error denial, request.resource.data create validation and undefined-field denial, resource.data existing-doc checks, custom token claims on request.auth.token, and updateDoc merged request.resource.data.',
  async observe() {
    const [
      { deleteApp, initializeApp },
      { deleteUser, getAuth, signInWithCustomToken },
      { signInOracleClientAuth },
      fsSdk,
      adminAppMod,
      { getAuth: getAdminAuth },
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
      import('firebase-admin/auth'),
      import('firebase-admin/firestore'),
      import('../../src/oracle-credential.ts'),
      import('../../src/oracle-rules-session.ts'),
      import('../../src/oracle-signal-restore.ts'),
      import('../../src/sdk-probe-runtime.ts'),
      import('../../src/storage-stdlib-real-lock.ts'),
    ]);

    const sa = await loadOracleServiceAccount();
    const webConfig = await resolveProbeWebConfig(sa);
    const runId = `wc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const basePath = `__pyric_fs_probe/${runId}`;
    const block = buildWriteAndCrossDocRulesBlock(runId);
    const target: OracleRulesTarget = {
      service: 'Firestore',
      release: 'cloud.firestore',
      rulesFileName: 'firestore.rules',
      marker: `@pyric/oracle-write-crossdoc-${runId}`,
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

    const unauthedApp = initializeApp(webConfig, `sdk-probe-wc-unauth-${runId}`);
    const plainApp = initializeApp(webConfig, `sdk-probe-wc-plain-${runId}`);
    const claimedApp = initializeApp(webConfig, `sdk-probe-wc-claim-${runId}`);
    const plainAuth = getAuth(plainApp);
    const claimedAuth = getAuth(claimedApp);
    const unauthedDb = fsSdk.getFirestore(unauthedApp);
    const plainDb = fsSdk.getFirestore(plainApp);
    const claimedDb = fsSdk.getFirestore(claimedApp);

    const adminApp = adminAppMod.initializeApp(oracleAppOptions(sa), `sdk-probe-wc-admin-${runId}`);
    const adminAuth = getAdminAuth(adminApp);
    const adminDb = getAdminFirestore(adminApp);
    const claimedUid = `sdk_claim_${runId}`;

    try {
      return await runWithOracleRulesRestored(session, async () => {
        await session.deploy(target);
        await signInOracleClientAuth(plainAuth, sa, `sdk-wc-plain-${runId}`);
        const customTok = await adminAuth.createCustomToken(claimedUid, { role: 'editor', tier: 2 });
        await signInWithCustomToken(claimedAuth, customTok);
        if (claimedAuth.currentUser) {
          await claimedAuth.currentUser.getIdToken(true);
        }
        const plainUid = plainAuth.currentUser?.uid ?? '';
        if (!plainUid) throw new Error('Expected plain signed-in uid');

        try {
          for (const [rel, docData] of Object.entries(seedDataForWriteAndCrossDoc(plainUid))) {
            await adminDb.doc(`${basePath}/${rel}`).set(docData);
          }

          const deadline = Date.now() + 90_000;
          let consecutive = 0;
          let round = 0;
          while (consecutive < 5) {
            if (Date.now() > deadline) {
              throw new Error('Timed out waiting for write/cross-doc rules propagation');
            }
            round += 1;
            try {
              await fsSdk.setDoc(fsSdk.doc(plainDb, `${basePath}/__ready/plain`), { round });
              await fsSdk.getDocFromServer(fsSdk.doc(plainDb, `${basePath}/__ready/plain`));
              await fsSdk.setDoc(fsSdk.doc(claimedDb, `${basePath}/__ready/claimed`), { round });
              await fsSdk.getDocFromServer(fsSdk.doc(claimedDb, `${basePath}/__ready/claimed`));
              await fsSdk.setDoc(fsSdk.doc(unauthedDb, `${basePath}/__ready/unauthed`), { round });
              await fsSdk.getDocFromServer(fsSdk.doc(unauthedDb, `${basePath}/__ready/unauthed`));
              consecutive += 1;
            } catch {
              consecutive = 0;
            }
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
          await new Promise((resolve) => setTimeout(resolve, 15_000));

          const dbFor = (kind: ProbeClientKind) => {
            if (kind === 'claimed') return claimedDb;
            if (kind === 'plain') return plainDb;
            return unauthedDb;
          };

          const subject: RulesWriteAndCrossDocSubject = {
            async readOutcome(kind, relPath) {
              try {
                await fsSdk.getDoc(fsSdk.doc(dbFor(kind), `${basePath}/${relPath}`));
                return 'allowed';
              } catch (err) {
                return `error:${errorCodeOf(err)}`;
              }
            },
            async setOutcome(kind, relPath, data) {
              try {
                await fsSdk.setDoc(fsSdk.doc(dbFor(kind), `${basePath}/${relPath}`), data);
                return 'allowed';
              } catch (err) {
                return `error:${errorCodeOf(err)}`;
              }
            },
            async updateOutcome(kind, relPath, data) {
              try {
                await fsSdk.updateDoc(fsSdk.doc(dbFor(kind), `${basePath}/${relPath}`), data);
                return 'allowed';
              } catch (err) {
                return `error:${errorCodeOf(err)}`;
              }
            },
          };

          return await observeFirestoreRulesWriteAndCrossDoc(subject, plainUid);
        } finally {
          if (plainAuth.currentUser) {
            await deleteUser(plainAuth.currentUser).catch(() => undefined);
          }
          if (claimedAuth.currentUser) {
            await deleteUser(claimedAuth.currentUser).catch(() => undefined);
          }
          await adminAuth.deleteUser(claimedUid).catch(() => undefined);
          await fsSdk.terminate(unauthedDb).catch(() => undefined);
          await fsSdk.terminate(plainDb).catch(() => undefined);
          await fsSdk.terminate(claimedDb).catch(() => undefined);
          await deleteApp(unauthedApp).catch(() => undefined);
          await deleteApp(plainApp).catch(() => undefined);
          await deleteApp(claimedApp).catch(() => undefined);
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
