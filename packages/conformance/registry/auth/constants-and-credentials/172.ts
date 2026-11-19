import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["ProviderId","SignInMethod","OperationType","ActionCodeOperation","AuthErrorCodes"],
  api: "ProviderId / SignInMethod / OperationType / ActionCodeOperation / AuthErrorCodes",
  behavior: "The constant maps, value for value. `OperationType.SIGN_IN === 'signIn'`, `SignInMethod.EMAIL_LINK === 'emailLink'`, `ProviderId.GOOGLE === 'google.com'`, `ActionCodeOperation.PASSWORD_RESET === 'PASSWORD_RESET'`, and the 106-entry `AuthErrorCodes` map (`INVALID_OOB_CODE === 'auth/invalid-action-code'`, `PROVIDER_ALREADY_LINKED === 'auth/provider-already-linked'`, `NO_SUCH_PROVIDER === 'auth/no-such-provider'`, `USER_MISMATCH === 'auth/user-mismatch'`, …).",
  status: "conforms",
  evidence: "ORACLE-BACKED, snapshotted straight from the shipped SDK: `auth-mechanical-surface-constants` against firebase-js-sdk 12.19.0, replayed value-for-value in `unit:oracle-conformance.test.ts`. This matters more than it looks: consumer code COMPARES against these constants, so a mirror that got a string wrong would turn every such comparison into a silent `false` — a worse failure than the export simply being absent, because it typechecks and runs. NOTE: the capture's `persistenceTypes` block is deliberately NOT asserted — the harness runs under Node, where firebase/auth stubs the browser-only persistence tokens to `type: 'NONE'` (it reports 'NONE' even for `browserLocalPersistence`, which is unambiguously 'LOCAL'); asserting it would be asserting a harness artifact. See auth#178.",
  risk: ["specific-value"],
  riskScore: 6,
  riskReasons: ["asserts every value of 4 constant maps plus 11 error codes"],
  automation: "oracle-backed",
  oracleObservations: ["auth-mechanical-surface-constants"],
  conformanceTests: ["packages/pyric/test/auth/oracle-conformance.test.ts"],
});
