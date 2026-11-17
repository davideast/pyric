import type { FirebaseOptions } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';
import { loadOracleServiceAccount } from '../../src/oracle-credential.ts';
import { resolveProbeWebConfig } from '../../src/sdk-probe-runtime.ts';
import {
  extractObservedErrorDetails,
  resolveProbeStorageBucket,
  withStorageProbeSession,
} from '../../src/storage-probe-session.ts';

interface ListAttemptOutcome {
  threw: boolean;
  code: string | null;
  isFirebaseError: boolean;
  itemNames: string[];
}

export interface StorageListAllRulesSubject {
  seedAllowedItem(): Promise<void>;
  listAllowedAuthenticated(): Promise<ListAttemptOutcome>;
  listOutsideGrantAuthenticated(): Promise<ListAttemptOutcome>;
  listAllowedSignedOut(): Promise<ListAttemptOutcome>;
}

export async function captureListAttempt(
  runList: () => Promise<string[]>,
): Promise<ListAttemptOutcome> {
  try {
    const itemNames = await runList();
    return {
      threw: false,
      code: null,
      isFirebaseError: false,
      itemNames,
    };
  } catch (err) {
    const details = extractObservedErrorDetails(err);
    return {
      threw: true,
      code: details.code,
      isFirebaseError: details.isFirebaseError,
      itemNames: [],
    };
  }
}

export async function observeListAllRulesEnforcement(
  subject: StorageListAllRulesSubject,
): Promise<Record<string, unknown>> {
  await subject.seedAllowedItem();
  const authenticatedAllowed = await subject.listAllowedAuthenticated();
  const authenticatedOutsideGrant = await subject.listOutsideGrantAuthenticated();
  const signedOutOnAuthRequiredPath = await subject.listAllowedSignedOut();

  return {
    authenticatedAllowed,
    authenticatedOutsideGrant,
    signedOutOnAuthRequiredPath,
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'listAll(ref) security-rules enforcement: observes allowed listAll under an authenticated read grant and FirebaseError storage/unauthorized both on paths outside any grant and from a signed-out client.',
  async observe() {
    const sa = await loadOracleServiceAccount();
    const webConfig = await resolveProbeWebConfig(sa);
    const resolvedBucket = resolveProbeStorageBucket(webConfig);
    const [{ deleteApp, initializeApp }, { getAuth }] = await Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
    ]);

    return withStorageProbeSession(async ({ runId, storage, objectPath, objectRef, storageSdk }) => {
      const allowedFolderPath = objectPath('listall-rules/allowed-dir');
      const outsideGrantPath = `pyric_oracle_denied_list/${runId}/forbidden-dir`;

      return observeListAllRulesEnforcement({
        async seedAllowedItem() {
          await storageSdk.uploadBytes(
            objectRef('listall-rules/allowed-dir/visible.bin'),
            new Uint8Array([0x07]),
          );
        },
        async listAllowedAuthenticated() {
          return captureListAttempt(async () => {
            const res = await storageSdk.listAll(storageSdk.ref(storage, allowedFolderPath));
            return res.items.map((item) => item.name);
          });
        },
        async listOutsideGrantAuthenticated() {
          return captureListAttempt(async () => {
            const res = await storageSdk.listAll(storageSdk.ref(storage, outsideGrantPath));
            return res.items.map((item) => item.name);
          });
        },
        async listAllowedSignedOut() {
          const signedOutOptions: FirebaseOptions = {
            ...(webConfig as FirebaseOptions),
            storageBucket: resolvedBucket,
          };
          const signedOutApp = initializeApp(
            signedOutOptions,
            `sdk-probe-listall-signed-out-${runId}`,
          );
          try {
            const signedOutAuth = getAuth(signedOutApp);
            if (signedOutAuth.currentUser !== null) {
              throw new Error('expected fresh secondary app to start signed out');
            }
            const signedOutStorage = storageSdk.getStorage(signedOutApp);
            return await captureListAttempt(async () => {
              const res = await storageSdk.listAll(
                storageSdk.ref(signedOutStorage, allowedFolderPath),
              );
              return res.items.map((item) => item.name);
            });
          } finally {
            await deleteApp(signedOutApp);
          }
        },
      });
    });
  },
};
