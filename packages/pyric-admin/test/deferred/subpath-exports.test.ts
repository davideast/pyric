/**
 * The `firebase-admin` subpaths the sandbox does not mirror.
 *
 * Under `pyric sandbox`, every `firebase-admin/*` import resolves to the same
 * subpath of `pyric-admin`. A subpath `pyric-admin` did not export failed at
 * resolve time with `ERR_PACKAGE_PATH_NOT_EXPORTED`, and passing it through to
 * the real `firebase-admin` would load a production SDK inside the sandbox.
 * Instead each one is a deferred entry: it resolves and links, and using any
 * export throws an error that names the subpath and says how to run it.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFERRED_SUBPATHS: ReadonlyArray<readonly [subpath: string, factory: string]> = [
  ['app-check', 'getAppCheck'],
  ['data-connect', 'getDataConnect'],
  ['eventarc', 'getEventarc'],
  ['extensions', 'getExtensions'],
  ['functions', 'getFunctions'],
  ['installations', 'getInstallations'],
  ['instance-id', 'getInstanceId'],
  ['machine-learning', 'getMachineLearning'],
  ['phone-number-verification', 'getPhoneNumberVerification'],
  ['project-management', 'getProjectManagement'],
  ['remote-config', 'getRemoteConfig'],
  ['security-rules', 'getSecurityRules'],
];

/** The message every deferred `pyric-admin` entry raises. */
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

describe('every firebase-admin subpath resolves in pyric-admin', () => {
  test('pyric-admin exports each subpath firebase-admin exports', () => {
    const upstream = exportedSubpaths(firebaseAdminManifest());
    const mirrored = exportedSubpaths(PYRIC_ADMIN_MANIFEST);
    expect(upstream.filter((subpath) => !mirrored.includes(subpath))).toEqual([]);
  });
});

describe('deferred pyric-admin subpaths', () => {
  for (const [subpath, factory] of DEFERRED_SUBPATHS) {
    describe(`pyric-admin/${subpath}`, () => {
      test('exports the same values as firebase-admin', async () => {
        const mirror = (await import(`pyric-admin/${subpath}`)) as Record<string, unknown>;
        const upstream = (await import(`firebase-admin/${subpath}`)) as Record<string, unknown>;
        const mirrored = Object.keys(mirror).filter((name) => name !== 'PyricDeferredApiError').sort();
        expect(mirrored).toEqual(Object.keys(upstream).filter((name) => name !== 'default').sort());
      });

      test(`${factory}() throws an attributed error with a remediation`, async () => {
        const mod = (await import(`pyric-admin/${subpath}`)) as Record<string, (...args: unknown[]) => unknown>;
        let thrown: unknown;
        try {
          mod[factory]!();
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        const error = thrown as Error & { name: string; subpath: string; symbol: string };
        expect(error.name).toBe('PyricDeferredApiError');
        expect(error.subpath).toBe(subpath);
        expect(error.symbol).toBe(factory);
        expect(error.message).toBe(deferredMessage(subpath));
      });
    });
  }
});
