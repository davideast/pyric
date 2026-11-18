import type { FirebaseOptions } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';
import { loadOracleServiceAccount, oracleAccessToken } from '../../src/oracle-credential.ts';
import {
  OracleRulesSession,
  runWithOracleRulesRestored,
  type OracleRulesTarget,
} from '../../src/oracle-rules-session.ts';
import { installOracleSignalRestoreGuard } from '../../src/oracle-signal-restore.ts';
import { resolveProbeWebConfig } from '../../src/sdk-probe-runtime.ts';
import { extractObservedErrorDetails, resolveProbeStorageBucket } from '../../src/storage-probe-session.ts';

const FIREBASE_MANAGEMENT_SCOPE = 'https://www.googleapis.com/auth/firebase';

interface RootListRefEntry {
  fullPath: string;
  name: string;
  parentFullPath: string | null;
}

interface StorageRootListAllSnapshot {
  rootFullPath: string;
  rootName: string;
  rootParentIsNull: boolean;
  items: RootListRefEntry[];
  prefixes: RootListRefEntry[];
  nextPageTokenIsUndefined: boolean;
}

export interface StorageListAllRootSubject {
  rootItemName: string;
  rootPrefixName: string;
  nestedChildFullPath: string;
  seedAndListRoot(): Promise<StorageRootListAllSnapshot>;
}

function isSortedByCodeUnits(values: readonly string[]): boolean {
  for (let i = 1; i < values.length; i += 1) {
    const prev = values[i - 1] ?? '';
    const curr = values[i] ?? '';
    if (prev > curr) {
      return false;
    }
  }
  return true;
}

export async function observeStorageListAllRootRef(
  subject: StorageListAllRootSubject,
): Promise<Record<string, unknown>> {
  const snapshot = await subject.seedAndListRoot();
  const containsSeededRootItem = snapshot.items.some(
    (entry) =>
      entry.fullPath === subject.rootItemName &&
      entry.name === subject.rootItemName &&
      entry.parentFullPath === '',
  );
  const containsSeededRootPrefix = snapshot.prefixes.some(
    (entry) =>
      entry.fullPath === subject.rootPrefixName &&
      entry.name === subject.rootPrefixName &&
      entry.parentFullPath === '',
  );
  const nestedChildExcludedFromRootItems = !snapshot.items.some(
    (entry) => entry.fullPath === subject.nestedChildFullPath || entry.fullPath.includes('/'),
  );
  const itemPaths = snapshot.items.map((entry) => entry.fullPath);
  const prefixPaths = snapshot.prefixes.map((entry) => entry.fullPath);

  return {
    rootFullPath: snapshot.rootFullPath,
    rootName: snapshot.rootName,
    rootParentIsNull: snapshot.rootParentIsNull,
    containsSeededRootItem,
    containsSeededRootPrefix,
    nestedChildExcludedFromRootItems,
    itemsSortedLexicographically: isSortedByCodeUnits(itemPaths),
    prefixesSortedLexicographically: isSortedByCodeUnits(prefixPaths),
    nextPageTokenIsUndefined: snapshot.nextPageTokenIsUndefined,
  };
}

function rootListOracleTarget(bucketId: string, runId: string, uid: string): OracleRulesTarget {
  const marker = `@pyric/oracle/storage-root-list/${runId}`;
  const scopedBlock = `    // ${marker}
    allow list: if request.auth != null && request.auth.uid == '${uid}';
    match /pyric_oracle_root_${runId}.bin {
      allow read, write: if request.auth != null && request.auth.uid == '${uid}';
    }
    match /pyric_oracle_root_${runId}/{allPaths=**} {
      allow read, write: if request.auth != null && request.auth.uid == '${uid}';
    }`;
  return {
    service: 'Storage',
    release: `firebase.storage/${bucketId}`,
    rulesFileName: 'storage.rules',
    marker,
    freshRules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
${scopedBlock}
  }
}
`,
    insertAfter: /(match\s+\/b\/\{bucket\}\/o\s*\{)/,
    insertAfterDescription: '`match /b/{bucket}/o`',
    block: `\n${scopedBlock}\n`,
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase/storage listAll(ref(storage)) on the root reference: observes bucket-root listing returning direct root items and top-level prefixes without recursing into nested children.',
  async observe() {
    const [
      { deleteApp, initializeApp },
      { deleteUser, getAuth, signInAnonymously },
      storageSdk,
    ] = await Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
      import('firebase/storage'),
    ]);

    const sa = await loadOracleServiceAccount();
    const webConfig = await resolveProbeWebConfig(sa);
    const storageBucket = resolveProbeStorageBucket(webConfig);
    const runId = `st_root_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const session = new OracleRulesSession({
      projectId: sa.project_id,
      accessToken: () => oracleAccessToken(sa, FIREBASE_MANAGEMENT_SCOPE),
    });
    const detachSignals = installOracleSignalRestoreGuard('[sdk-probes]', () =>
      session.restoreAll(),
    );

    const appOptions: FirebaseOptions = {
      ...(webConfig as FirebaseOptions),
      storageBucket,
    };
    const clientApp = initializeApp(appOptions, `sdk-probe-storage-root-list-${runId}`);
    const clientAuth = getAuth(clientApp);
    const storage = storageSdk.getStorage(clientApp);

    const rootPrefixName = `pyric_oracle_root_${runId}`;
    const rootItemName = `${rootPrefixName}.bin`;
    const nestedChildFullPath = `${rootPrefixName}/nested/child.bin`;
    const rootItemRef = storageSdk.ref(storage, rootItemName);
    const nestedChildRef = storageSdk.ref(storage, nestedChildFullPath);

    try {
      return await runWithOracleRulesRestored(session, async () => {
        const cred = await signInAnonymously(clientAuth);
        const uid = cred.user.uid;
        if (!/^[A-Za-z0-9_-]+$/.test(uid)) {
          throw new Error('unexpected characters in anonymous uid');
        }
        await session.deploy(rootListOracleTarget(storageBucket, runId, uid));
        await new Promise((resolve) => setTimeout(resolve, 10_000));

        try {
          return await observeStorageListAllRootRef({
            rootItemName,
            rootPrefixName,
            nestedChildFullPath,
            async seedAndListRoot() {
              const rootRef = storageSdk.ref(storage);
              let lastErr: unknown = null;
              for (let attempt = 0; attempt < 5; attempt += 1) {
                try {
                  await storageSdk.uploadBytes(rootItemRef, new Uint8Array([0x41]));
                  await storageSdk.uploadBytes(nestedChildRef, new Uint8Array([0x42, 0x43]));
                  const res = await storageSdk.listAll(rootRef);
                  return {
                    rootFullPath: rootRef.fullPath,
                    rootName: rootRef.name,
                    rootParentIsNull: rootRef.parent === null,
                    items: res.items.map((item) => {
                      let parentFullPath: string | null = null;
                      if (item.parent !== null) {
                        parentFullPath = item.parent.fullPath;
                      }
                      return {
                        fullPath: item.fullPath,
                        name: item.name,
                        parentFullPath,
                      };
                    }),
                    prefixes: res.prefixes.map((prefix) => {
                      let parentFullPath: string | null = null;
                      if (prefix.parent !== null) {
                        parentFullPath = prefix.parent.fullPath;
                      }
                      return {
                        fullPath: prefix.fullPath,
                        name: prefix.name,
                        parentFullPath,
                      };
                    }),
                    nextPageTokenIsUndefined: res.nextPageToken === undefined,
                  };
                } catch (err) {
                  lastErr = err;
                  const details = extractObservedErrorDetails(err);
                  if (details.code === 'storage/unauthorized' && attempt < 4) {
                    await new Promise((resolve) => setTimeout(resolve, 3_000));
                    continue;
                  }
                  throw err;
                }
              }
              throw lastErr;
            },
          });
        } finally {
          await storageSdk.deleteObject(rootItemRef).catch(() => undefined);
          await storageSdk.deleteObject(nestedChildRef).catch(() => undefined);
          if (clientAuth.currentUser) {
            await deleteUser(clientAuth.currentUser).catch(() => undefined);
          }
        }
      });
    } finally {
      await deleteApp(clientApp).catch(() => undefined);
      detachSignals();
    }
  },
};
