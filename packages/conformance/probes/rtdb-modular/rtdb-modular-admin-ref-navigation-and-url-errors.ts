import type { Database as AdminDatabase, Reference as AdminReference } from 'firebase-admin/database';
import type { Probe } from '../../rigs/types.ts';
import { RTDB_RULES_SCOPE } from '../../src/oracle-access-token.ts';
import { loadOracleServiceAccount, oracleAccessToken } from '../../src/oracle-credential.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface SyncThrowSummary {
  threw: boolean;
  errorName: string | null;
  code: string | null;
  message: string | null;
}

function scrubOriginAndRunPath(
  rawText: string,
  databaseOrigin: string,
  databaseHost: string,
  cleanRunPath: string,
): string {
  let out = rawText.split(databaseOrigin).join('<databaseOrigin>');
  out = out.split(databaseHost).join('<databaseHost>');
  if (cleanRunPath) {
    out = out.split(`/${cleanRunPath}`).join('/<runPath>');
    out = out.split(cleanRunPath).join('<runPath>');
  }
  return out;
}

function captureSyncCall(
  invoke: () => unknown,
  databaseOrigin: string,
  databaseHost: string,
  cleanRunPath: string,
): SyncThrowSummary {
  try {
    invoke();
    return {
      threw: false,
      errorName: null,
      code: null,
      message: null,
    };
  } catch (err) {
    const errorObj = err as Error & { code?: unknown };
    let code: string | null = null;
    if (typeof errorObj.code === 'string') {
      code = errorObj.code;
    }
    return {
      threw: true,
      errorName: errorObj.name,
      code,
      message: scrubOriginAndRunPath(errorObj.message, databaseOrigin, databaseHost, cleanRunPath),
    };
  }
}

export async function observeAdminRefNavigationAndUrlErrors(
  adminDb: Pick<AdminDatabase, 'ref' | 'refFromURL'>,
  databaseUrl: string,
  basePath: string,
): Promise<{
  rootRef: {
    noArgKey: string | null;
    noArgParentIsNull: boolean;
    noArgToString: string;
    slashArgEqualsNoArg: boolean;
    undefinedArgEqualsNoArg: boolean;
  };
  nestedNavigation: {
    leafKey: string | null;
    parentKey: string | null;
    rootKey: string | null;
    rootParentIsNull: boolean;
    toString: string;
    toJSONEqualsToString: boolean;
    slashNormalizedIsEqual: boolean;
    siblingIsEqual: boolean;
    childChainingIsEqual: boolean;
  };
  refFromUrlLiveRouting: {
    urlRefEqualsPathRef: boolean;
    queryStringIgnoredKey: string | null;
    writtenViaRefFromUrlReadViaRef: unknown;
  };
  syncThrows: {
    emptyStringRef: SyncThrowSummary;
    isEqualNull: SyncThrowSummary;
    refFromUrlHostMismatch: SyncThrowSummary;
    refFromUrlWithFragment: SyncThrowSummary;
    refFromUrlMalformed: SyncThrowSummary;
  };
}> {
  const databaseOrigin = databaseUrl.replace(/\/+$/, '');
  const databaseHost = new URL(databaseOrigin).host;
  const cleanRunPath = basePath.replace(/^\/+|\/+$/g, '');

  const noArgRoot = adminDb.ref();
  const slashRoot = adminDb.ref('/');
  const undefinedRoot = adminDb.ref(undefined);

  let scopedPrefix = 'nav';
  if (cleanRunPath) {
    scopedPrefix = `${cleanRunPath}/nav`;
  }

  const leafRef = adminDb.ref(`${scopedPrefix}/orders/ord-1`);
  const slashyLeafRef = adminDb.ref(`///${scopedPrefix}//orders///ord-1//`);
  const siblingRef = adminDb.ref(`${scopedPrefix}/orders/ord-2`);
  const chainedLeafRef = adminDb.ref(scopedPrefix).child('orders').child('ord-1');

  let parentKey: string | null = null;
  if (leafRef.parent !== null) {
    parentKey = leafRef.parent.key;
  }

  const urlTargetPath = `${scopedPrefix}/urlTarget`;
  const urlRef = adminDb.refFromURL(`${databaseOrigin}/${urlTargetPath}`);
  const urlWithQueryRef = adminDb.refFromURL(`${databaseOrigin}/${urlTargetPath}?print=silent&ns=ignored`);
  const pathTargetRef = adminDb.ref(urlTargetPath);

  await urlRef.set({ routed: 'ok', count: 3 });
  const readBackSnap = await pathTargetRef.get();

  const leafToString = scrubOriginAndRunPath(
    leafRef.toString(),
    databaseOrigin,
    databaseHost,
    cleanRunPath,
  );
  const leafToJson = scrubOriginAndRunPath(
    String(leafRef.toJSON()),
    databaseOrigin,
    databaseHost,
    cleanRunPath,
  );

  return {
    rootRef: {
      noArgKey: noArgRoot.key,
      noArgParentIsNull: noArgRoot.parent === null,
      noArgToString: scrubOriginAndRunPath(
        noArgRoot.toString(),
        databaseOrigin,
        databaseHost,
        cleanRunPath,
      ),
      slashArgEqualsNoArg: slashRoot.isEqual(noArgRoot),
      undefinedArgEqualsNoArg: undefinedRoot.isEqual(noArgRoot),
    },
    nestedNavigation: {
      leafKey: leafRef.key,
      parentKey,
      rootKey: leafRef.root.key,
      rootParentIsNull: leafRef.root.parent === null,
      toString: leafToString,
      toJSONEqualsToString: leafToJson === leafToString,
      slashNormalizedIsEqual: leafRef.isEqual(slashyLeafRef),
      siblingIsEqual: leafRef.isEqual(siblingRef),
      childChainingIsEqual: leafRef.isEqual(chainedLeafRef),
    },
    refFromUrlLiveRouting: {
      urlRefEqualsPathRef: urlRef.isEqual(pathTargetRef),
      queryStringIgnoredKey: urlWithQueryRef.key,
      writtenViaRefFromUrlReadViaRef: readBackSnap.val(),
    },
    syncThrows: {
      emptyStringRef: captureSyncCall(
        () => adminDb.ref(''),
        databaseOrigin,
        databaseHost,
        cleanRunPath,
      ),
      isEqualNull: captureSyncCall(
        () => leafRef.isEqual(null as unknown as AdminReference),
        databaseOrigin,
        databaseHost,
        cleanRunPath,
      ),
      refFromUrlHostMismatch: captureSyncCall(
        () => adminDb.refFromURL('https://mismatched-other-instance.firebaseio.com/orders/ord-1'),
        databaseOrigin,
        databaseHost,
        cleanRunPath,
      ),
      refFromUrlWithFragment: captureSyncCall(
        () => adminDb.refFromURL(`${databaseOrigin}/orders/ord-1#section`),
        databaseOrigin,
        databaseHost,
        cleanRunPath,
      ),
      refFromUrlMalformed: captureSyncCall(
        () => adminDb.refFromURL('not-a-valid-url'),
        databaseOrigin,
        databaseHost,
        cleanRunPath,
      ),
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  pendingRowLink: true,
  description:
    'firebase-admin/database Reference navigation and URL resolution: observes db.ref(), db.ref("/"), db.ref("") throw, child/parent/root/key/toString/toJSON, isEqual() and isEqual(null) throw, and live db.refFromURL() routing plus host-mismatch/fragment/malformed URL throws.',
  matrixRow: '',
  rowIds: [],
  observe() {
    return withRtdbProbeSession({}, async ({ runId, runPath, databaseUrl }) => {
      const [adminAppMod, { getDatabaseWithUrl }] = await Promise.all([
        import('firebase-admin/app'),
        import('firebase-admin/database'),
      ]);
      const sa = await loadOracleServiceAccount();
      const adminApp = adminAppMod.initializeApp(
        {
          credential: {
            getAccessToken: async () => ({
              access_token: await oracleAccessToken(sa, RTDB_RULES_SCOPE),
              expires_in: 3600,
            }),
          },
          projectId: sa.project_id,
          databaseURL: databaseUrl,
        },
        `sdk-probe-rtdb-admin-nav-${runId}`,
      );
      const adminDb = getDatabaseWithUrl(databaseUrl, adminApp);
      try {
        return await observeAdminRefNavigationAndUrlErrors(adminDb, databaseUrl, runPath);
      } finally {
        adminDb.goOffline();
        await adminAppMod.deleteApp(adminApp).catch(() => undefined);
      }
    });
  },
};
