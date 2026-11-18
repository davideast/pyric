import { describe, expect, it } from 'bun:test';
import { deleteApp, initializeApp } from 'pyric-admin/app';
import {
  FirebaseDatabaseError,
  getDatabase,
  getDatabaseWithUrl,
  ServerValue,
} from 'pyric-admin/database';
import { observeAdminConnectionAndOnDisconnect } from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-admin-connection-and-ondisconnect.ts';
import {
  observeAdminFirebaseDatabaseErrorAndUrlBinding,
  type AdminErrorAndUrlSdk,
  type FirebaseDatabaseErrorConstructorLike,
} from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-admin-firebasedatabaseerror-and-url-binding.ts';
import { observeAdminPrioritiesAndInlinePriority } from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-admin-priorities-and-inline-priority.ts';
import { observeAdminRefNavigationAndUrlErrors } from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-admin-ref-navigation-and-url-errors.ts';
import { observeAdminWritesSentinelsAndValidation } from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-admin-writes-sentinels-and-validation.ts';
import {
  hostedRtdbContext,
  load,
  restoreSharedWorker,
  servedRtdbContext,
  type ServedRtdbAdminContext,
} from './support.ts';

restoreSharedWorker();

const DEFAULT_ORACLE_URL = 'https://demo-oracle-default-rtdb.firebaseio.com';
let tempAppSeq = 0;

type AdminPlaneFactory = () => Promise<ServedRtdbAdminContext>;

const PLANES: ReadonlyArray<[string, AdminPlaneFactory]> = [
  ['served SharedWorker', () => servedRtdbContext()],
  ['served Node host', () => hostedRtdbContext()],
];

for (const [planeLabel, createContext] of PLANES) {
  describe(`RTDB admin database, priorities, and URL binding oracle captures (${planeLabel})`, () => {
    it('rtdb-modular-admin-ref-navigation-and-url-errors (rtdb-admin#2)', async () => {
      const ctx = await createContext();
      const adminDb = await ctx.openAdminDb(DEFAULT_ORACLE_URL);
      const actual = await observeAdminRefNavigationAndUrlErrors(
        adminDb as unknown as Parameters<typeof observeAdminRefNavigationAndUrlErrors>[0],
        DEFAULT_ORACLE_URL,
        ctx.base,
      );
      expect(actual as unknown).toEqual(load('rtdb-modular-admin-ref-navigation-and-url-errors'));
    });

    it('rtdb-modular-admin-writes-sentinels-and-validation (rtdb-admin#3)', async () => {
      const ctx = await createContext();
      const adminDb = await ctx.openAdminDb(DEFAULT_ORACLE_URL);
      const actual = await observeAdminWritesSentinelsAndValidation(
        adminDb as unknown as Parameters<typeof observeAdminWritesSentinelsAndValidation>[0],
        ServerValue,
        ctx.base,
      );
      expect(actual as unknown).toEqual(load('rtdb-modular-admin-writes-sentinels-and-validation'));
    });

    it('rtdb-modular-admin-connection-and-ondisconnect (rtdb-admin#6)', async () => {
      const ctx = await createContext();
      const writerDb = await ctx.openAdminDb(DEFAULT_ORACLE_URL);
      const observerDb = await ctx.openAdminDb(DEFAULT_ORACLE_URL);
      const actual = await observeAdminConnectionAndOnDisconnect(
        writerDb as unknown as Parameters<typeof observeAdminConnectionAndOnDisconnect>[0],
        observerDb as unknown as Parameters<typeof observeAdminConnectionAndOnDisconnect>[1],
        ctx.base,
      );
      expect(actual as unknown).toEqual(load('rtdb-modular-admin-connection-and-ondisconnect'));
    });

    it('rtdb-modular-admin-priorities-and-inline-priority (rtdb-admin#7)', async () => {
      const ctx = await createContext();
      const adminDb = await ctx.openAdminDb(DEFAULT_ORACLE_URL);
      const actual = await observeAdminPrioritiesAndInlinePriority(
        adminDb as unknown as Parameters<typeof observeAdminPrioritiesAndInlinePriority>[0],
        ctx.base,
      );
      expect(actual as unknown).toEqual(load('rtdb-modular-admin-priorities-and-inline-priority'));
    });

    it('rtdb-modular-admin-firebasedatabaseerror-and-url-binding (rtdb-admin#1, #10, rtdb-modular#MI4)', async () => {
      const ctx = await createContext();
      const remoteSandbox = await ctx.openRemoteSandbox();
      const expected = load('rtdb-modular-admin-firebasedatabaseerror-and-url-binding') as {
        errorConstructorContract: Record<string, unknown>;
        urlBindingAndHandleCaching: {
          sameExactUrlReturnsSameHandle: boolean;
          appOptionsUrlMatchesExplicitGetDatabaseWithUrl: boolean;
          liveWriteViaGetDatabaseReadViaGetDatabaseWithUrl: unknown;
          trailingSlashVariantOnOpenInstance: Record<string, unknown>;
          missingDatabaseUrlThrow: Record<string, unknown>;
          emptyUrlGetDatabaseWithUrlThrow: Record<string, unknown>;
        };
      };

      const sdk: AdminErrorAndUrlSdk = {
        FirebaseDatabaseError:
          FirebaseDatabaseError as unknown as FirebaseDatabaseErrorConstructorLike,
        getDatabase: (app) => getDatabase(app as never) as never,
        getDatabaseWithUrl: (url, app) => getDatabaseWithUrl(url, app as never) as never,
        createTempApp(options, label) {
          tempAppSeq += 1;
          return initializeApp(
            {
              sandbox: remoteSandbox,
              projectId: options.projectId,
              databaseURL: options.databaseURL,
            },
            `served-admin-url-${tempAppSeq}-${label}`,
          ) as never;
        },
        async deleteTempApp(app) {
          await deleteApp(app as never);
        },
      };

      const actual = await observeAdminFirebaseDatabaseErrorAndUrlBinding(
        sdk,
        DEFAULT_ORACLE_URL,
        ctx.base,
      );

      expect(actual.errorConstructorContract).toEqual(expected.errorConstructorContract as never);
      expect(actual.urlBindingAndHandleCaching.sameExactUrlReturnsSameHandle).toBe(
        expected.urlBindingAndHandleCaching.sameExactUrlReturnsSameHandle,
      );
      expect(actual.urlBindingAndHandleCaching.appOptionsUrlMatchesExplicitGetDatabaseWithUrl).toBe(
        expected.urlBindingAndHandleCaching.appOptionsUrlMatchesExplicitGetDatabaseWithUrl,
      );
      expect(
        actual.urlBindingAndHandleCaching.liveWriteViaGetDatabaseReadViaGetDatabaseWithUrl,
      ).toEqual(
        expected.urlBindingAndHandleCaching.liveWriteViaGetDatabaseReadViaGetDatabaseWithUrl,
      );
      expect(actual.urlBindingAndHandleCaching.trailingSlashVariantOnOpenInstance).toEqual(
        expected.urlBindingAndHandleCaching.trailingSlashVariantOnOpenInstance as never,
      );
      expect(actual.urlBindingAndHandleCaching.emptyUrlGetDatabaseWithUrlThrow).toEqual(
        expected.urlBindingAndHandleCaching.emptyUrlGetDatabaseWithUrlThrow as never,
      );

      // KNOWN DIVERGENCE (rtdb-admin#1): omitting app.options.databaseURL resolves the
      // default project instance in pyric-admin so zero-config local apps run, whereas
      // production throws database/invalid-argument.
      expect(expected.urlBindingAndHandleCaching.missingDatabaseUrlThrow).toEqual({
        threw: true,
        isErrorInstance: true,
        code: 'database/invalid-argument',
        message: "Can't determine Firebase Database URL.",
      });
      expect(actual.urlBindingAndHandleCaching.missingDatabaseUrlThrow).toEqual({
        threw: false,
        isErrorInstance: false,
        code: null,
        message: null,
      });
    });
  });
}
