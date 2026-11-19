import type { Probe } from '../../rigs/types.ts';
import type { OracleRulesTarget } from '../../src/oracle-rules-session.ts';

const FIREBASE_MANAGEMENT_SCOPE = 'https://www.googleapis.com/auth/firebase';
const FIRESTORE_REAL_LOCK = '/tmp/pyric-firestore-real.lock';

export const CEL_PROBE_CASE_IDS = [
  'dot_missing',
  'index_missing_eq_null',
  'present_null',
  'error_or_true',
  'true_or_error',
  'error_and_false',
  'in_and_map_get',
  'list_oob',
  'matches_partial',
  'matches_full_replace_split',
  'proto_in_tostring',
  'proto_dot_constructor',
  'proto_own_keys_only',
  'bad_plus_str_int',
  'bad_plus_lists',
  'list_concat_and_is_map',
  'cross_type_lt',
  'int_float_and_div',
  'div_by_zero',
  'bad_int_parse',
  'unknown_bool_fn',
  'non_bool_and',
] as const;

export interface RulesCelAndSetEqualitySubject {
  readOutcome(relPath: string): Promise<string>;
  setOutcome(relPath: string, data: Record<string, unknown>): Promise<string>;
  updateOutcome(relPath: string, data: Record<string, unknown>): Promise<string>;
}

export function buildCelAndSetEqualityRulesBlock(runId: string): string {
  return `      // @pyric/oracle-cel-set-${runId}
      match /__pyric_fs_probe/${runId} {
        match /__ready/{id} {
          allow read, write: if true;
        }
        match /cases/dot_missing {
          allow get: if resource.data.missingKey == 'x';
        }
        match /cases/index_missing_eq_null {
          allow get: if resource.data['missingKey'] == null;
        }
        match /cases/present_null {
          allow get: if resource.data['presentNull'] == null && resource.data.presentNull == null;
        }
        match /cases/error_or_true {
          allow get: if (resource.data.missingKey == 'x') || true;
        }
        match /cases/true_or_error {
          allow get: if true || (resource.data.missingKey == 'x');
        }
        match /cases/error_and_false {
          allow get: if !((resource.data.missingKey == 'x') && false);
        }
        match /cases/in_and_map_get {
          allow get: if !('missingKey' in resource.data)
            && resource.data.get('missingKey', 'fallback') == 'fallback';
        }
        match /cases/list_oob {
          allow get: if resource.data.items[5] == 'x';
        }
        match /cases/matches_partial {
          allow get: if resource.data.sampleStr.matches('b');
        }
        match /cases/matches_full_replace_split {
          allow get: if resource.data.sampleStr.matches('a.c')
            && resource.data.dashed.replace('-', '_') == 'a_b_c'
            && resource.data.delimited.split('[,;]') == ['a', 'b', 'c'];
        }
        match /cases/proto_in_tostring {
          allow get: if 'toString' in resource.data;
        }
        match /cases/proto_dot_constructor {
          allow get: if resource.data.constructor == null;
        }
        match /cases/proto_own_keys_only {
          allow get: if !('toString' in resource.data)
            && !resource.data.keys().hasAll(['toString'])
            && resource.data.get('toString', 'safe') == 'safe';
        }
        match /cases/bad_plus_str_int {
          allow get: if (resource.data.strVal + resource.data.intVal) == 'a1';
        }
        match /cases/bad_plus_lists {
          allow get: if (resource.data.listA + resource.data.listB) == [1, 2];
        }
        match /cases/list_concat_and_is_map {
          allow get: if resource.data.listA.concat(resource.data.listB) == [1, 2]
            && !([1].toSet() is map)
            && !(resource.data.diff(resource.data) is map);
        }
        match /cases/cross_type_lt {
          allow get: if resource.data.intVal < resource.data.strVal;
        }
        match /cases/int_float_and_div {
          allow get: if !(resource.data.onePointFive is int)
            && !(resource.data.intVal is float)
            && (1.0 is float)
            && (resource.data.tenVal / resource.data.fourVal == 2)
            && (string(1.0) == '1.0');
        }
        match /cases/div_by_zero {
          allow get: if (resource.data.intVal / resource.data.zeroVal) == 0;
        }
        match /cases/bad_int_parse {
          allow get: if int(resource.data.badIntStr) == 12;
        }
        match /cases/unknown_bool_fn {
          allow get: if bool('true') == true;
        }
        match /cases/non_bool_and {
          allow get: if resource.data.intVal && true;
        }
        match /set_cases/{id} {
          allow update: if request.resource.data.members.diff(resource.data.members).addedKeys() == ['c', 'b'].toSet()
            && request.resource.data.members.diff(resource.data.members).addedKeys() != ['b', 'c'];
        }
        match /create_ok/{id} {
          allow create: if request.resource.data.ratio is float;
        }
        match /create_resource_eq_null/{id} {
          allow create: if resource == null;
        }
        match /create_read_null_res/{id} {
          allow create: if resource.data.ratio == 1.5;
        }
      }`;
}

export function seedDataForCelAndSetEquality(): Record<string, Record<string, unknown>> {
  const baseDoc: Record<string, unknown> = {
    presentNull: null,
    items: ['x', 'y'],
    strVal: 'a',
    intVal: 1,
    zeroVal: 0,
    tenVal: 10,
    fourVal: 4,
    onePointFive: 1.5,
    badIntStr: '12abc',
    sampleStr: 'abc',
    delimited: 'a,b;c',
    dashed: 'a-b-c',
    listA: [1],
    listB: [2],
  };
  const seeded: Record<string, Record<string, unknown>> = {
    '__ready/check': { ok: true },
    'set_cases/exact': { members: { alice: 'admin' } },
    'set_cases/partial': { members: { alice: 'admin' } },
  };
  for (const caseId of CEL_PROBE_CASE_IDS) {
    seeded[`cases/${caseId}`] = { ...baseDoc };
  }
  return seeded;
}

export async function observeFirestoreRulesCelAndSetEquality(
  subject: RulesCelAndSetEqualitySubject,
): Promise<Record<string, unknown>> {
  const readCases: Record<string, string> = {};
  for (const caseId of CEL_PROBE_CASE_IDS) {
    readCases[caseId] = await subject.readOutcome(`cases/${caseId}`);
  }

  const setExactMatch = await subject.updateOutcome('set_cases/exact', {
    members: { alice: 'admin', b: 'member', c: 'member' },
  });
  const setPartialMismatch = await subject.updateOutcome('set_cases/partial', {
    members: { alice: 'admin', b: 'member' },
  });

  const createFloatAllowed = await subject.setOutcome('create_ok/doc1', { ratio: 1.5 });
  const createIntDenied = await subject.setOutcome('create_ok/doc2', { ratio: 2 });
  const createResourceEqNullDenied = await subject.setOutcome('create_resource_eq_null/doc1', { ratio: 1.5 });
  const createReadingNullResourceDenied = await subject.setOutcome('create_read_null_res/doc1', { ratio: 1.5 });

  return {
    readCases,
    setEquality: {
      exactOrderInsensitiveMatch: setExactMatch,
      partialSetMismatch: setPartialMismatch,
    },
    createVerdicts: {
      requestResourceFloatAllowed: createFloatAllowed,
      requestResourceIntDenied: createIntDenied,
      resourceEqNullOnCreateDenied: createResourceEqNullDenied,
      readingResourceDataOnCreateDenied: createReadingNullResourceDenied,
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
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'Firestore security-rules CEL expressions, tri-state error absorption, RE2 string helpers, prototype isolation, type-strict operators, FirestoreSet value equality, int/float casts, strict boolean control flow, and create-time resource == null observed via the client SDK.',
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
    const runId = `cel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const basePath = `__pyric_fs_probe/${runId}`;
    const block = buildCelAndSetEqualityRulesBlock(runId);
    const target: OracleRulesTarget = {
      service: 'Firestore',
      release: 'cloud.firestore',
      rulesFileName: 'firestore.rules',
      marker: `@pyric/oracle-cel-set-${runId}`,
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

    const clientApp = initializeApp(webConfig, `sdk-probe-cel-${runId}`);
    const clientAuth = getAuth(clientApp);
    const db = fsSdk.getFirestore(clientApp);
    const adminApp = adminAppMod.initializeApp(oracleAppOptions(sa), `sdk-probe-cel-admin-${runId}`);
    const adminDb = getAdminFirestore(adminApp);

    try {
      return await runWithOracleRulesRestored(session, async () => {
        await session.deploy(target);
        await signInOracleClientAuth(clientAuth, sa, `sdk-cel-${runId}`);

        try {
          for (const [rel, docData] of Object.entries(seedDataForCelAndSetEquality())) {
            await adminDb.doc(`${basePath}/${rel}`).set(docData);
          }

          const deadline = Date.now() + 90_000;
          let consecutive = 0;
          let round = 0;
          while (consecutive < 5) {
            if (Date.now() > deadline) {
              throw new Error('Timed out waiting for CEL rules propagation');
            }
            round += 1;
            try {
              await fsSdk.setDoc(fsSdk.doc(db, `${basePath}/__ready/client`), { round });
              await fsSdk.getDocFromServer(fsSdk.doc(db, `${basePath}/__ready/client`));
              consecutive += 1;
            } catch {
              consecutive = 0;
            }
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
          await new Promise((resolve) => setTimeout(resolve, 15_000));

          const subject: RulesCelAndSetEqualitySubject = {
            async readOutcome(relPath) {
              try {
                await fsSdk.getDoc(fsSdk.doc(db, `${basePath}/${relPath}`));
                return 'allowed';
              } catch (err) {
                return `error:${errorCodeOf(err)}`;
              }
            },
            async setOutcome(relPath, data) {
              try {
                await fsSdk.setDoc(fsSdk.doc(db, `${basePath}/${relPath}`), data);
                return 'allowed';
              } catch (err) {
                return `error:${errorCodeOf(err)}`;
              }
            },
            async updateOutcome(relPath, data) {
              try {
                await fsSdk.updateDoc(fsSdk.doc(db, `${basePath}/${relPath}`), data);
                return 'allowed';
              } catch (err) {
                return `error:${errorCodeOf(err)}`;
              }
            },
          };

          return await observeFirestoreRulesCelAndSetEquality(subject);
        } finally {
          if (clientAuth.currentUser) {
            await deleteUser(clientAuth.currentUser).catch(() => undefined);
          }
          await fsSdk.terminate(db).catch(() => undefined);
          await deleteApp(clientApp).catch(() => undefined);
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
