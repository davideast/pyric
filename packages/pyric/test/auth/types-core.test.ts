import { expect, it } from 'bun:test';
import type {
  AuthError,
  AuthErrorMap,
  AuthSettings,
  CompleteFn,
  Config,
  CustomParameters,
  Dependencies,
  EmulatorConfig,
  ErrorFn,
  NextFn,
  NextOrObserver,
  OAuthCredentialOptions,
  ParsedToken,
  PopupRedirectResolver,
  ReactNativeAsyncStorage,
  User,
  UserMetadata,
  UserProfile,
} from 'pyric/auth';
import type {
  AuthError as UpstreamAuthError,
  AuthErrorMap as UpstreamAuthErrorMap,
  AuthSettings as UpstreamAuthSettings,
  CompleteFn as UpstreamCompleteFn,
  Config as UpstreamConfig,
  CustomParameters as UpstreamCustomParameters,
  Dependencies as UpstreamDependencies,
  EmulatorConfig as UpstreamEmulatorConfig,
  ErrorFn as UpstreamErrorFn,
  NextFn as UpstreamNextFn,
  NextOrObserver as UpstreamNextOrObserver,
  OAuthCredentialOptions as UpstreamOAuthCredentialOptions,
  ParsedToken as UpstreamParsedToken,
  PopupRedirectResolver as UpstreamPopupRedirectResolver,
  ReactNativeAsyncStorage as UpstreamReactNativeAsyncStorage,
  UserMetadata as UpstreamUserMetadata,
  UserProfile as UpstreamUserProfile,
} from 'firebase/auth';

type Assignable<From, To> = [From] extends [To] ? true : false;
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? true
  : false;

function assertType<T extends true>(): void {}

function verifyAuthCorePublicTypesCompile(): void {
  assertType<Exact<CompleteFn, UpstreamCompleteFn>>();
  assertType<Exact<ErrorFn, UpstreamErrorFn>>();
  assertType<Exact<NextFn<string>, UpstreamNextFn<string>>>();
  assertType<Exact<NextOrObserver<User>, UpstreamNextOrObserver<User>>>();

  assertType<Assignable<AuthError, UpstreamAuthError>>();
  assertType<Exact<AuthError['customData'], UpstreamAuthError['customData']>>();
  assertType<Exact<Omit<AuthError, 'name'>, Omit<UpstreamAuthError, 'name'>>>();

  assertType<Exact<AuthSettings, UpstreamAuthSettings>>();
  assertType<Exact<Config, UpstreamConfig>>();
  assertType<Exact<CustomParameters, UpstreamCustomParameters>>();
  assertType<Exact<PopupRedirectResolver, UpstreamPopupRedirectResolver>>();
  assertType<Exact<AuthErrorMap, UpstreamAuthErrorMap>>();
  assertType<Exact<Dependencies, UpstreamDependencies>>();
  assertType<Exact<EmulatorConfig, UpstreamEmulatorConfig>>();
  assertType<Exact<OAuthCredentialOptions, UpstreamOAuthCredentialOptions>>();
  assertType<Exact<ParsedToken, UpstreamParsedToken>>();
  assertType<Exact<ReactNativeAsyncStorage, UpstreamReactNativeAsyncStorage>>();
  assertType<Exact<UserMetadata, UpstreamUserMetadata>>();
  assertType<Exact<UserProfile, UpstreamUserProfile>>();

  const parsedToken: ParsedToken = {
    sub: 'uid-1',
    auth_time: '1700000000',
    iat: '1700000000',
    exp: '1700003600',
    firebase: {
      sign_in_provider: 'password',
      identities: { email: 'alice@example.com' },
    },
    role: 'editor',
  };
  const upstreamToken: UpstreamParsedToken = parsedToken;
  const roundTripToken: ParsedToken = upstreamToken;
  void roundTripToken;
}

it('pyric/auth core public types match upstream firebase/auth declarations under strict tsc', () => {
  verifyAuthCorePublicTypesCompile();
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
      'test/auth/types-core.test.ts',
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
