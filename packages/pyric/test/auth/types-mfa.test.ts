import { expect, it } from 'bun:test';
import type {
  ApplicationVerifier,
  ConfirmationResult,
  MultiFactorAssertion,
  MultiFactorError,
  MultiFactorInfo,
  MultiFactorResolver,
  MultiFactorSession,
  MultiFactorUser,
  PhoneAuthCredential,
  PhoneAuthProvider,
  PhoneInfoOptions,
  PhoneMultiFactorAssertion,
  PhoneMultiFactorEnrollInfoOptions,
  PhoneMultiFactorGenerator,
  PhoneMultiFactorInfo,
  PhoneMultiFactorSignInInfoOptions,
  PhoneSingleFactorInfoOptions,
  RecaptchaParameters,
  RecaptchaVerifier,
  TotpMultiFactorAssertion,
  TotpMultiFactorGenerator,
  TotpMultiFactorInfo,
  TotpSecret,
} from 'pyric/auth';
import type {
  ApplicationVerifier as UpstreamApplicationVerifier,
  ConfirmationResult as UpstreamConfirmationResult,
  MultiFactorAssertion as UpstreamMultiFactorAssertion,
  MultiFactorError as UpstreamMultiFactorError,
  MultiFactorInfo as UpstreamMultiFactorInfo,
  MultiFactorResolver as UpstreamMultiFactorResolver,
  MultiFactorSession as UpstreamMultiFactorSession,
  MultiFactorUser as UpstreamMultiFactorUser,
  PhoneAuthCredential as UpstreamPhoneAuthCredential,
  PhoneAuthProvider as UpstreamPhoneAuthProvider,
  PhoneInfoOptions as UpstreamPhoneInfoOptions,
  PhoneMultiFactorAssertion as UpstreamPhoneMultiFactorAssertion,
  PhoneMultiFactorEnrollInfoOptions as UpstreamPhoneMultiFactorEnrollInfoOptions,
  PhoneMultiFactorGenerator as UpstreamPhoneMultiFactorGenerator,
  PhoneMultiFactorInfo as UpstreamPhoneMultiFactorInfo,
  PhoneMultiFactorSignInInfoOptions as UpstreamPhoneMultiFactorSignInInfoOptions,
  PhoneSingleFactorInfoOptions as UpstreamPhoneSingleFactorInfoOptions,
  RecaptchaParameters as UpstreamRecaptchaParameters,
  RecaptchaVerifier as UpstreamRecaptchaVerifier,
  TotpMultiFactorAssertion as UpstreamTotpMultiFactorAssertion,
  TotpMultiFactorGenerator as UpstreamTotpMultiFactorGenerator,
  TotpMultiFactorInfo as UpstreamTotpMultiFactorInfo,
  TotpSecret as UpstreamTotpSecret,
} from 'firebase/auth';

type Assignable<From, To> = [From] extends [To] ? true : false;
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? true
  : false;

function assertType<T extends true>(): void {}

function verifyAuthMfaPublicTypesCompile(): void {
  assertType<Exact<ApplicationVerifier, UpstreamApplicationVerifier>>();
  assertType<Assignable<UpstreamConfirmationResult, ConfirmationResult>>();
  assertType<Exact<ConfirmationResult['verificationId'], UpstreamConfirmationResult['verificationId']>>();

  assertType<Exact<MultiFactorAssertion, UpstreamMultiFactorAssertion>>();
  assertType<Assignable<MultiFactorError, UpstreamMultiFactorError>>();
  assertType<Exact<MultiFactorError['customData'], UpstreamMultiFactorError['customData']>>();
  assertType<Exact<MultiFactorInfo, UpstreamMultiFactorInfo>>();
  assertType<Exact<MultiFactorSession, UpstreamMultiFactorSession>>();
  assertType<Assignable<UpstreamMultiFactorResolver, MultiFactorResolver>>();
  assertType<Exact<MultiFactorResolver['hints'], UpstreamMultiFactorResolver['hints']>>();
  assertType<Exact<MultiFactorResolver['session'], UpstreamMultiFactorResolver['session']>>();
  assertType<Exact<MultiFactorUser, UpstreamMultiFactorUser>>();

  assertType<Assignable<UpstreamPhoneAuthCredential, PhoneAuthCredential>>();
  assertType<Exact<PhoneSingleFactorInfoOptions, UpstreamPhoneSingleFactorInfoOptions>>();
  assertType<Exact<PhoneMultiFactorEnrollInfoOptions, UpstreamPhoneMultiFactorEnrollInfoOptions>>();
  assertType<Exact<PhoneMultiFactorSignInInfoOptions, UpstreamPhoneMultiFactorSignInInfoOptions>>();
  assertType<Exact<PhoneInfoOptions, UpstreamPhoneInfoOptions>>();
  assertType<Assignable<UpstreamPhoneAuthProvider, PhoneAuthProvider>>();
  assertType<Exact<PhoneMultiFactorAssertion, UpstreamPhoneMultiFactorAssertion>>();
  assertType<Assignable<UpstreamPhoneMultiFactorGenerator, PhoneMultiFactorGenerator>>();
  assertType<Exact<PhoneMultiFactorInfo, UpstreamPhoneMultiFactorInfo>>();

  assertType<Assignable<RecaptchaParameters, UpstreamRecaptchaParameters>>();
  assertType<Assignable<UpstreamRecaptchaParameters, RecaptchaParameters>>();
  assertType<Assignable<UpstreamRecaptchaVerifier, RecaptchaVerifier>>();

  assertType<Exact<TotpMultiFactorAssertion, UpstreamTotpMultiFactorAssertion>>();
  assertType<Exact<TotpMultiFactorGenerator, UpstreamTotpMultiFactorGenerator>>();
  assertType<Exact<TotpMultiFactorInfo, UpstreamTotpMultiFactorInfo>>();
  assertType<Assignable<UpstreamTotpSecret, TotpSecret>>();
  assertType<Exact<TotpSecret['generateQrCodeUrl'], UpstreamTotpSecret['generateQrCodeUrl']>>();

  const phoneInfo: PhoneInfoOptions = { phoneNumber: '+16505550101' };
  const upstreamPhoneInfo: UpstreamPhoneInfoOptions = phoneInfo;
  const roundTripPhoneInfo: PhoneInfoOptions = upstreamPhoneInfo;
  void roundTripPhoneInfo;
}

it('pyric/auth MFA, phone, TOTP, and reCAPTCHA types match upstream firebase/auth declarations under strict tsc', () => {
  verifyAuthMfaPublicTypesCompile();
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
      'test/auth/types-mfa.test.ts',
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
