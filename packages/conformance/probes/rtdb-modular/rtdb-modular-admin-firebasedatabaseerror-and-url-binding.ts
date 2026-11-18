import type { App as AdminApp } from 'firebase-admin/app';
import type { Database as AdminDatabase } from 'firebase-admin/database';
import type { Probe } from '../../rigs/types.ts';
import { RTDB_RULES_SCOPE } from '../../src/oracle-access-token.ts';
import { loadOracleServiceAccount, oracleAccessToken } from '../../src/oracle-credential.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface FirebaseDatabaseErrorConstructorLike {
  new (info: { code: string; message: string }, message?: string): Error & {
    readonly code: string;
    readonly message: string;
    toJSON(): { code: string; message: string };
  };
}

export interface AdminErrorAndUrlSdk {
  FirebaseDatabaseError: FirebaseDatabaseErrorConstructorLike;
  getDatabase(app?: AdminApp): AdminDatabase;
  getDatabaseWithUrl(url: string, app?: AdminApp): AdminDatabase;
  createTempApp(options: { projectId: string; databaseURL?: string }, label: string): AdminApp;
  deleteTempApp(app: AdminApp): Promise<void>;
}

export interface CapturedAdminThrow {
  threw: boolean;
  isErrorInstance: boolean;
  code: string | null;
  message: string | null;
}

function captureSyncCall(invoke: () => unknown): CapturedAdminThrow {
  try {
    invoke();
    return {
      threw: false,
      isErrorInstance: false,
      code: null,
      message: null,
    };
  } catch (err) {
    const rawCode = (err as { code?: unknown }).code;
    let code: string | null = null;
    if (typeof rawCode === 'string') {
      code = rawCode;
    }
    return {
      threw: true,
      isErrorInstance: err instanceof Error,
      code,
      message: (err as Error).message,
    };
  }
}

export async function observeAdminFirebaseDatabaseErrorAndUrlBinding(
  sdk: AdminErrorAndUrlSdk,
  databaseUrl: string,
  basePath: string,
): Promise<{
  errorConstructorContract: {
    exportedAsFunction: boolean;
    defaultMessageInstanceIsError: boolean;
    defaultCodePrefixed: string;
    defaultMessage: string;
    defaultToJson: { code: string; message: string };
    overrideMessageApplied: string;
    overrideToJson: { code: string; message: string };
  };
  urlBindingAndHandleCaching: {
    sameExactUrlReturnsSameHandle: boolean;
    appOptionsUrlMatchesExplicitGetDatabaseWithUrl: boolean;
    liveWriteViaGetDatabaseReadViaGetDatabaseWithUrl: unknown;
    trailingSlashVariantOnOpenInstance: CapturedAdminThrow;
    missingDatabaseUrlThrow: CapturedAdminThrow;
    emptyUrlGetDatabaseWithUrlThrow: CapturedAdminThrow;
  };
}> {
  const ErrCtor = sdk.FirebaseDatabaseError;
  const exportedAsFunction = typeof ErrCtor === 'function';
  const errDefault = new ErrCtor({
    code: 'invalid-argument',
    message: 'Default info message.',
  });
  const errOverride = new ErrCtor(
    {
      code: 'network-error',
      message: 'Default network message.',
    },
    'Explicit override message.',
  );

  const normalizedNoSlash = databaseUrl.replace(/\/+$/g, '');
  const withTrailingSlash = `${normalizedNoSlash}/`;

  const appWithUrl = sdk.createTempApp(
    { projectId: 'demo-url-binding', databaseURL: normalizedNoSlash },
    'with-url',
  );
  const appWithoutUrl = sdk.createTempApp({ projectId: 'demo-url-binding' }, 'without-url');

  let liveReadVal: unknown = null;
  let sameExactUrlReturnsSameHandle = false;
  let appOptionsUrlMatchesExplicitGetDatabaseWithUrl = false;
  let trailingSlashVariantOnOpenInstance: CapturedAdminThrow = {
    threw: false,
    isErrorInstance: false,
    code: null,
    message: null,
  };

  const dbFromOptions = sdk.getDatabase(appWithUrl);
  try {
    const dbExplicit1 = sdk.getDatabaseWithUrl(normalizedNoSlash, appWithUrl);
    const dbExplicit2 = sdk.getDatabaseWithUrl(normalizedNoSlash, appWithUrl);
    sameExactUrlReturnsSameHandle = dbExplicit1 === dbExplicit2;
    appOptionsUrlMatchesExplicitGetDatabaseWithUrl = dbFromOptions === dbExplicit1;

    const cleanBase = basePath.replace(/^\/+|\/+$/g, '');
    let targetPath = 'adminUrlBind/check';
    if (cleanBase) {
      targetPath = `${cleanBase}/adminUrlBind/check`;
    }
    await dbFromOptions.ref(targetPath).set({ bound: true, seq: 1 });
    const snap = await dbExplicit1.ref(targetPath).get();
    liveReadVal = snap.val();

    trailingSlashVariantOnOpenInstance = captureSyncCall(() =>
      sdk.getDatabaseWithUrl(withTrailingSlash, appWithUrl),
    );
  } finally {
    dbFromOptions.goOffline();
    await sdk.deleteTempApp(appWithUrl).catch(() => undefined);
  }

  let missingDatabaseUrlThrow: CapturedAdminThrow;
  let emptyUrlGetDatabaseWithUrlThrow: CapturedAdminThrow;
  try {
    missingDatabaseUrlThrow = captureSyncCall(() => sdk.getDatabase(appWithoutUrl));
    emptyUrlGetDatabaseWithUrlThrow = captureSyncCall(() =>
      sdk.getDatabaseWithUrl('', appWithoutUrl),
    );
  } finally {
    await sdk.deleteTempApp(appWithoutUrl).catch(() => undefined);
  }

  return {
    errorConstructorContract: {
      exportedAsFunction,
      defaultMessageInstanceIsError: errDefault instanceof Error,
      defaultCodePrefixed: errDefault.code,
      defaultMessage: errDefault.message,
      defaultToJson: errDefault.toJSON(),
      overrideMessageApplied: errOverride.message,
      overrideToJson: errOverride.toJSON(),
    },
    urlBindingAndHandleCaching: {
      sameExactUrlReturnsSameHandle,
      appOptionsUrlMatchesExplicitGetDatabaseWithUrl,
      liveWriteViaGetDatabaseReadViaGetDatabaseWithUrl: liveReadVal,
      trailingSlashVariantOnOpenInstance,
      missingDatabaseUrlThrow,
      emptyUrlGetDatabaseWithUrlThrow,
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  pendingRowLink: true,
  description:
    'firebase-admin/database FirebaseDatabaseError runtime constructor contract (database/ prefix, message override, toJSON) and getDatabase(app) / getDatabaseWithUrl(url, app) handle caching, live routing, and invalid-argument / format-mismatch throws.',
  matrixRow: '',
  rowIds: [],
  observe() {
    return withRtdbProbeSession({}, async ({ runId, runPath, databaseUrl }) => {
      const [adminAppMod, adminDbMod] = await Promise.all([
        import('firebase-admin/app'),
        import('firebase-admin/database'),
      ]);
      const sa = await loadOracleServiceAccount();
      const credential = {
        getAccessToken: async () => ({
          access_token: await oracleAccessToken(sa, RTDB_RULES_SCOPE),
          expires_in: 3600,
        }),
      };
      return observeAdminFirebaseDatabaseErrorAndUrlBinding(
        {
          FirebaseDatabaseError:
            adminDbMod.FirebaseDatabaseError as unknown as FirebaseDatabaseErrorConstructorLike,
          getDatabase: adminDbMod.getDatabase,
          getDatabaseWithUrl: adminDbMod.getDatabaseWithUrl,
          createTempApp(options, label) {
            return adminAppMod.initializeApp(
              {
                credential,
                projectId: sa.project_id,
                databaseURL: options.databaseURL,
              },
              `sdk-probe-rtdb-admin-err-${runId}-${label}`,
            );
          },
          deleteTempApp(app) {
            return adminAppMod.deleteApp(app);
          },
        },
        databaseUrl,
        runPath,
      );
    });
  },
};
