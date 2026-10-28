/**
 * The `firebase-admin` subpaths the sandbox does not mirror.
 *
 * Under `pyric sandbox`, every `firebase-admin/*` import resolves to the same
 * subpath of `pyric-admin`. Each unmodeled service exports an `App`-bound
 * handle from `get<Service>(app?)` (and matching `admin.<service>(app?)`) so
 * module-level initialization loads cleanly when a service is unused or
 * disabled, while calling any method on the handle or touching any non-service
 * export fails with `PyricDeferredApiError` naming the symbol and subpath.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeSandbox } from 'pyric/sandbox';
import admin from 'pyric-admin';
import { deleteApp, getApps, initializeApp, type PyricAdminApp } from 'pyric-admin/app';
import { PyricDeferredApiError } from 'pyric-admin/remote-config';

interface DeferredSubpathSpec {
  readonly subpath: string;
  readonly factory: string;
  readonly serviceClass: string;
  readonly rootAccessor?:
    | 'installations'
    | 'instanceId'
    | 'machineLearning'
    | 'projectManagement'
    | 'remoteConfig'
    | 'securityRules';
  readonly extraExports?: readonly string[];
  readonly syncMethod?: string;
  readonly asyncMethod?: string;
  readonly factoryArgs?: readonly unknown[];
}

const DEFERRED_SUBPATHS: readonly DeferredSubpathSpec[] = [
  {
    subpath: 'data-connect',
    factory: 'getDataConnect',
    serviceClass: 'DataConnect',
    extraExports: ['validateAdminArgs'],
    asyncMethod: 'executeQuery',
    factoryArgs: [{ location: 'us-central1', serviceId: 'my-service', connector: 'my-connector' }],
  },
  {
    subpath: 'eventarc',
    factory: 'getEventarc',
    serviceClass: 'Eventarc',
    extraExports: ['Channel'],
    syncMethod: 'channel',
  },
  {
    subpath: 'extensions',
    factory: 'getExtensions',
    serviceClass: 'Extensions',
    extraExports: ['Runtime'],
    syncMethod: 'runtime',
  },
  {
    subpath: 'functions',
    factory: 'getFunctions',
    serviceClass: 'Functions',
    extraExports: ['TaskQueue'],
    syncMethod: 'taskQueue',
  },
  {
    subpath: 'installations',
    factory: 'getInstallations',
    serviceClass: 'Installations',
    rootAccessor: 'installations',
    extraExports: ['FirebaseInstallationsError', 'InstallationsClientErrorCode'],
    asyncMethod: 'deleteInstallation',
  },
  {
    subpath: 'instance-id',
    factory: 'getInstanceId',
    serviceClass: 'InstanceId',
    rootAccessor: 'instanceId',
    extraExports: ['FirebaseInstanceIdError', 'InstanceIdClientErrorCode'],
    asyncMethod: 'deleteInstanceId',
  },
  {
    subpath: 'machine-learning',
    factory: 'getMachineLearning',
    serviceClass: 'MachineLearning',
    rootAccessor: 'machineLearning',
    extraExports: ['Model'],
    asyncMethod: 'getModel',
  },
  {
    subpath: 'phone-number-verification',
    factory: 'getPhoneNumberVerification',
    serviceClass: 'PhoneNumberVerification',
    asyncMethod: 'verifyToken',
  },
  {
    subpath: 'project-management',
    factory: 'getProjectManagement',
    serviceClass: 'ProjectManagement',
    rootAccessor: 'projectManagement',
    extraExports: ['AndroidApp', 'AppPlatform', 'FirebaseProjectManagementError', 'IosApp', 'ShaCertificate'],
    syncMethod: 'androidApp',
    asyncMethod: 'listAppMetadata',
  },
  {
    subpath: 'remote-config',
    factory: 'getRemoteConfig',
    serviceClass: 'RemoteConfig',
    rootAccessor: 'remoteConfig',
    extraExports: ['CustomSignalOperator', 'PercentConditionOperator', 'RemoteConfigFetchResponse'],
    syncMethod: 'createTemplateFromJSON',
    asyncMethod: 'getTemplate',
  },
  {
    subpath: 'security-rules',
    factory: 'getSecurityRules',
    serviceClass: 'SecurityRules',
    rootAccessor: 'securityRules',
    extraExports: ['Ruleset', 'RulesetMetadataList'],
    syncMethod: 'createRulesFileFromSource',
    asyncMethod: 'getRuleset',
  },
];

/** The message every non-service export or direct service constructor raises. */
function deferredMessage(subpath: string): string {
  return (
    `pyric: 'firebase-admin/${subpath}' is not mirrored by the local sandbox, so its calls fail here. ` +
    'Imports resolve so module graphs load. Code that needs this service runs against Firebase outside ' +
    'the sandbox: start it without `pyric sandbox`, or keep the call off the code path the sandbox runs.'
  );
}

/** The `exports` subpaths of a package.json, without the leading `./`. */
function exportedSubpaths(packageJsonPath: string): string[] {
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { exports: Record<string, unknown> };
  return Object.keys(manifest.exports)
    .filter((key) => key !== '.')
    .map((key) => key.slice(2))
    .sort();
}

/** The installed `firebase-admin` package.json, found from its resolved entry. */
function firebaseAdminManifest(): string {
  let dir = dirname(fileURLToPath(import.meta.resolve('firebase-admin')));
  for (;;) {
    const candidate = join(dir, 'package.json');
    try {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
      if (manifest.name === 'firebase-admin') return candidate;
    } catch { /* not a package root */ }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('firebase-admin package.json not found');
    dir = parent;
  }
}

const PYRIC_ADMIN_MANIFEST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');

beforeEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('every firebase-admin subpath resolves in pyric-admin', () => {
  test('pyric-admin exports each subpath firebase-admin exports', () => {
    const upstream = exportedSubpaths(firebaseAdminManifest());
    const mirrored = exportedSubpaths(PYRIC_ADMIN_MANIFEST);
    expect(upstream.filter((subpath) => !mirrored.includes(subpath))).toEqual([]);
  });
});

describe('deferred pyric-admin subpaths', () => {
  for (const spec of DEFERRED_SUBPATHS) {
    const { subpath, factory, serviceClass, rootAccessor, extraExports = [], syncMethod, asyncMethod, factoryArgs = [] } = spec;
    const callWithApp = (fn: (...args: unknown[]) => unknown, app?: PyricAdminApp) =>
      app !== undefined ? fn(...factoryArgs, app) : fn(...factoryArgs);

    describe(`pyric-admin/${subpath}`, () => {
      test('exports the same values as firebase-admin', async () => {
        const mirror = (await import(`pyric-admin/${subpath}`)) as Record<string, unknown>;
        const upstream = (await import(`firebase-admin/${subpath}`)) as Record<string, unknown>;
        const mirrored = Object.keys(mirror).filter((name) => name !== 'PyricDeferredApiError').sort();
        expect(mirrored).toEqual(Object.keys(upstream).filter((name) => name !== 'default').sort());
      });

      test(`${factory}() throws FirebaseAppError app/no-app before initializeApp()`, async () => {
        const mod = (await import(`pyric-admin/${subpath}`)) as Record<string, (...args: unknown[]) => unknown>;
        let thrown: unknown;
        try {
          callWithApp(mod[factory]!);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        const error = thrown as Error & { code?: string };
        expect(error.name).toBe('FirebaseAppError');
        expect(error.code).toBe('app/no-app');
      });

      test(`${factory}(app) returns a cached App-bound ${serviceClass} handle and rejects deleted apps`, async () => {
        const mod = (await import(`pyric-admin/${subpath}`)) as Record<string, unknown>;
        const fn = mod[factory] as (...args: unknown[]) => { readonly app: PyricAdminApp };
        const ServiceCtor = mod[serviceClass] as new () => unknown;

        const defaultApp = initializeApp({ sandbox: initializeSandbox() });
        const handleNoArg = callWithApp(fn) as { readonly app: PyricAdminApp };
        const handleExplicit = callWithApp(fn, defaultApp) as { readonly app: PyricAdminApp };
        expect(handleNoArg).toBe(handleExplicit);
        expect(handleNoArg.app).toBe(defaultApp);
        expect(handleNoArg).toBeInstanceOf(ServiceCtor);

        if (rootAccessor) {
          expect(admin[rootAccessor]()).toBe(handleNoArg);
          expect(admin[rootAccessor](defaultApp)).toBe(handleExplicit);
        }

        // Direct construction with `new <Service>()` fails loudly with attribution.
        let ctorThrown: unknown;
        try {
          new ServiceCtor();
        } catch (error) {
          ctorThrown = error;
        }
        expect(ctorThrown).toBeInstanceOf(PyricDeferredApiError);
        expect((ctorThrown as PyricDeferredApiError).subpath).toBe(subpath);
        expect((ctorThrown as PyricDeferredApiError).symbol).toBe(serviceClass);
        expect((ctorThrown as Error).message).toBe(deferredMessage(subpath));

        await deleteApp(defaultApp);
        let deletedThrown: unknown;
        try {
          callWithApp(fn, defaultApp);
        } catch (error) {
          deletedThrown = error;
        }
        expect((deletedThrown as { code?: string }).code).toBe('app/app-deleted');
      });

      test(`${serviceClass} methods fail with PyricDeferredApiError at invocation time`, async () => {
        const mod = (await import(`pyric-admin/${subpath}`)) as Record<string, unknown>;
        const fn = mod[factory] as (...args: unknown[]) => Record<string, () => unknown>;
        const app = initializeApp({ sandbox: initializeSandbox() });
        const handle = callWithApp(fn, app) as Record<string, () => unknown>;

        if (syncMethod) {
          let syncThrown: unknown;
          try {
            handle[syncMethod]!();
          } catch (error) {
            syncThrown = error;
          }
          expect(syncThrown).toBeInstanceOf(PyricDeferredApiError);
          expect((syncThrown as PyricDeferredApiError).subpath).toBe(`pyric-admin/${subpath}`);
          expect((syncThrown as PyricDeferredApiError).symbol).toBe(`${serviceClass}.${syncMethod}`);
        }

        if (asyncMethod) {
          const result = handle[asyncMethod]!();
          expect(result).toBeInstanceOf(Promise);
          const asyncThrown = await (result as Promise<unknown>).then(
            () => undefined,
            (error: unknown) => error,
          );
          expect(asyncThrown).toBeInstanceOf(PyricDeferredApiError);
          expect((asyncThrown as PyricDeferredApiError).subpath).toBe(`pyric-admin/${subpath}`);
          expect((asyncThrown as PyricDeferredApiError).symbol).toBe(`${serviceClass}.${asyncMethod}`);
        }

        for (const extra of extraExports) {
          const exportVal = mod[extra] as () => unknown;
          let extraThrown: unknown;
          try {
            exportVal();
          } catch (error) {
            extraThrown = error;
          }
          expect(extraThrown).toBeInstanceOf(PyricDeferredApiError);
          expect((extraThrown as PyricDeferredApiError).subpath).toBe(subpath);
          expect((extraThrown as PyricDeferredApiError).symbol).toBe(extra);
        }
      });
    });
  }
});
