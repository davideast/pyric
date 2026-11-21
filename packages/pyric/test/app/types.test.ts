import { expect, it } from 'bun:test';
import type {
  FirebaseApp,
  FirebaseAppSettings,
  FirebaseOptions,
  FirebaseServerApp,
  FirebaseServerAppSettings,
} from 'pyric/app';
import type {
  FirebaseApp as UpstreamFirebaseApp,
  FirebaseAppSettings as UpstreamFirebaseAppSettings,
  FirebaseOptions as UpstreamFirebaseOptions,
  FirebaseServerApp as UpstreamFirebaseServerApp,
  FirebaseServerAppSettings as UpstreamFirebaseServerAppSettings,
} from 'firebase/app';

type Assignable<From, To> = [From] extends [To] ? true : false;
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? true
  : false;

function assertType<T extends true>(): void {}

function verifyAppPublicTypesCompile(): void {
  assertType<Exact<FirebaseOptions, UpstreamFirebaseOptions>>();
  assertType<Exact<FirebaseAppSettings, UpstreamFirebaseAppSettings>>();
  assertType<Exact<FirebaseApp, UpstreamFirebaseApp>>();

  assertType<Assignable<FirebaseServerAppSettings, UpstreamFirebaseServerAppSettings>>();
  assertType<Assignable<UpstreamFirebaseServerAppSettings, FirebaseServerAppSettings>>();
  assertType<Exact<Required<FirebaseServerAppSettings>, Required<UpstreamFirebaseServerAppSettings>>>();
  assertType<'name' extends keyof FirebaseServerAppSettings ? false : true>();

  assertType<Assignable<FirebaseServerApp, UpstreamFirebaseServerApp>>();
  assertType<Assignable<UpstreamFirebaseServerApp, FirebaseServerApp>>();
  assertType<Assignable<FirebaseServerApp, FirebaseApp>>();
  assertType<Exact<Pick<FirebaseServerApp, 'name'>, Pick<UpstreamFirebaseServerApp, 'name'>>>();
  assertType<
    Exact<Pick<FirebaseServerApp, 'settings'>, Pick<UpstreamFirebaseServerApp, 'settings'>>
  >();

  const releaseTarget = {};
  const settings: FirebaseServerAppSettings = {
    authIdToken: 'header.payload.signature',
    appCheckToken: 'app-check-token',
    automaticDataCollectionEnabled: false,
    releaseOnDeref: releaseTarget,
  };
  const upstreamSettings: UpstreamFirebaseServerAppSettings = settings;
  const roundTripSettings: FirebaseServerAppSettings = upstreamSettings;
  void roundTripSettings;
}

it('pyric/app public types match upstream firebase/app declarations under strict tsc', () => {
  verifyAppPublicTypesCompile();
  const result = Bun.spawnSync(
    [
      process.execPath,
      'x',
      'tsc',
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--module',
      'ES2022',
      '--moduleResolution',
      'bundler',
      '--target',
      'ES2022',
      '--types',
      'bun-types',
      'test/app/types.test.ts',
    ],
    {
      cwd: `${import.meta.dir}/../..`,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  expect(result.exitCode, output).toBe(0);
}, 30_000);
