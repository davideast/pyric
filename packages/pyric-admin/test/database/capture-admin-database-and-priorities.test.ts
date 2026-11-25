import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import {
  FirebaseDatabaseError,
  getDatabase,
  getDatabaseWithUrl,
  ServerValue,
} from '../../src/database/index.js';
import { observeAdminConnectionAndOnDisconnect } from '../../../conformance/probes/rtdb-modular/rtdb-modular-admin-connection-and-ondisconnect.ts';
import {
  observeAdminFirebaseDatabaseErrorAndUrlBinding,
  type AdminErrorAndUrlSdk,
  type FirebaseDatabaseErrorConstructorLike,
} from '../../../conformance/probes/rtdb-modular/rtdb-modular-admin-firebasedatabaseerror-and-url-binding.ts';
import { observeAdminPrioritiesAndInlinePriority } from '../../../conformance/probes/rtdb-modular/rtdb-modular-admin-priorities-and-inline-priority.ts';
import { observeAdminRefNavigationAndUrlErrors } from '../../../conformance/probes/rtdb-modular/rtdb-modular-admin-ref-navigation-and-url-errors.ts';
import { observeAdminWritesSentinelsAndValidation } from '../../../conformance/probes/rtdb-modular/rtdb-modular-admin-writes-sentinels-and-validation.ts';

const OBS_DIR = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'rtdb-modular',
);

function load(stemOrFile: string): Record<string, unknown> {
  let filename = `${stemOrFile}.json`;
  if (stemOrFile.endsWith('.json')) {
    filename = stemOrFile;
  }
  const parsed = JSON.parse(readFileSync(join(OBS_DIR, filename), 'utf8')) as {
    behavior: Record<string, unknown>;
  };
  return parsed.behavior;
}

let appSeq = 0;

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

function createLocalAdminPair() {
  appSeq += 1;
  const projectId = `demo-admin-cdd-${appSeq}`;
  const databaseUrl = `https://${projectId}-default-rtdb.firebaseio.com`;
  const sandbox = initializeSandbox({ projectId });
  const appA = initializeApp(
    { sandbox, projectId, databaseURL: databaseUrl },
    `admin-cdd-a-${appSeq}`,
  );
  const appB = initializeApp(
    { sandbox, projectId, databaseURL: databaseUrl },
    `admin-cdd-b-${appSeq}`,
  );
  return {
    sandbox,
    projectId,
    databaseUrl,
    dbA: getDatabase(appA),
    dbB: getDatabase(appB),
  };
}

describe('RTDB admin database, priorities, and URL binding oracle captures (in-process pyric-admin)', () => {
  it('rtdb-modular-admin-ref-navigation-and-url-errors (rtdb-admin#2)', async () => {
    const { dbA, databaseUrl } = createLocalAdminPair();
    const expected = load('rtdb-modular-admin-ref-navigation-and-url-errors');
    const actual = await observeAdminRefNavigationAndUrlErrors(
      dbA as unknown as Parameters<typeof observeAdminRefNavigationAndUrlErrors>[0],
      databaseUrl,
      '/pyric_oracle/rtdb_admin_nav',
    );
    expect(actual as unknown).toEqual(expected);
  });

  it('rtdb-modular-admin-writes-sentinels-and-validation (rtdb-admin#3)', async () => {
    const { dbA } = createLocalAdminPair();
    const expected = load('rtdb-modular-admin-writes-sentinels-and-validation');
    const actual = await observeAdminWritesSentinelsAndValidation(
      dbA as unknown as Parameters<typeof observeAdminWritesSentinelsAndValidation>[0],
      ServerValue,
      '/pyric_oracle/rtdb_admin_writes',
    );
    expect(actual as unknown).toEqual(expected);
  });

  it('rtdb-modular-admin-connection-and-ondisconnect (rtdb-admin#6)', async () => {
    const { dbA, dbB } = createLocalAdminPair();
    const expected = load('rtdb-modular-admin-connection-and-ondisconnect');
    const actual = await observeAdminConnectionAndOnDisconnect(
      dbA as unknown as Parameters<typeof observeAdminConnectionAndOnDisconnect>[0],
      dbB as unknown as Parameters<typeof observeAdminConnectionAndOnDisconnect>[1],
      '/pyric_oracle/rtdb_admin_disc',
    );
    expect(actual as unknown).toEqual(expected);
  });

  it('rtdb-modular-admin-priorities-and-inline-priority (rtdb-admin#7)', async () => {
    const { dbA } = createLocalAdminPair();
    const expected = load('rtdb-modular-admin-priorities-and-inline-priority');
    const actual = await observeAdminPrioritiesAndInlinePriority(
      dbA as unknown as Parameters<typeof observeAdminPrioritiesAndInlinePriority>[0],
      '/pyric_oracle/rtdb_admin_prio',
    );
    expect(actual as unknown).toEqual(expected);
  });

  it('rtdb-modular-admin-firebasedatabaseerror-and-url-binding (rtdb-admin#1, #10, rtdb-modular#MI4)', async () => {
    const { sandbox, databaseUrl } = createLocalAdminPair();
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
        appSeq += 1;
        return initializeApp(
          {
            sandbox,
            projectId: options.projectId,
            databaseURL: options.databaseURL,
          },
          `admin-url-cdd-${appSeq}-${label}`,
        ) as never;
      },
      async deleteTempApp(app) {
        await deleteApp(app as never);
      },
    };

    const actual = await observeAdminFirebaseDatabaseErrorAndUrlBinding(
      sdk,
      databaseUrl,
      '/pyric_oracle/rtdb_admin_url',
    );

    expect(actual.errorConstructorContract).toEqual(expected.errorConstructorContract as never);
    const sampleErr = new FirebaseDatabaseError(
      { code: 'invalid-argument', message: 'Default info message.' },
      'Explicit override message.',
    );
    expect(Object.keys(sampleErr).sort()).toEqual(['code', 'codePrefix']);
    expect(sampleErr.code).toBe('database/invalid-argument');
    expect(sampleErr.codePrefix).toBe('database');
    expect(sampleErr.hasCode('invalid-argument')).toBe(true);
    expect(sampleErr.hasCode('database/invalid-argument')).toBe(true);
    expect(sampleErr.toJSON()).toEqual({
      code: 'database/invalid-argument',
      message: 'Explicit override message.',
    });
    expect(sampleErr.name).toBe('Error');
    const prefixedInputErr = new FirebaseDatabaseError({
      code: 'database/invalid-argument',
      message: 'Already prefixed.',
    });
    expect(prefixedInputErr.code).toBe('database/database/invalid-argument');
    expect(actual.urlBindingAndHandleCaching.sameExactUrlReturnsSameHandle).toBe(
      expected.urlBindingAndHandleCaching.sameExactUrlReturnsSameHandle,
    );
    expect(actual.urlBindingAndHandleCaching.appOptionsUrlMatchesExplicitGetDatabaseWithUrl).toBe(
      expected.urlBindingAndHandleCaching.appOptionsUrlMatchesExplicitGetDatabaseWithUrl,
    );
    expect(
      actual.urlBindingAndHandleCaching.liveWriteViaGetDatabaseReadViaGetDatabaseWithUrl,
    ).toEqual(expected.urlBindingAndHandleCaching.liveWriteViaGetDatabaseReadViaGetDatabaseWithUrl);
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
