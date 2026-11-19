import { row } from './section.ts';

export default row({
  order: 100,
  featureKeys: ["providerData"],
  api: "User.providerData",
  behavior: "One entry PER LINKED PROVIDER, read from the identity's stored record. Previously the sandbox synthesized a single `{providerId: 'password'}` entry for EVERY non-anonymous user, so a Google popup sign-in reported its provider as `'password'` and a linked account could never show more than one. Consumer code branches on this array (that is what it is for -- 'is this account linked to Google?'), so the synthesized version was actively misleading. Empty for custom-token and anonymous users at birth; populated on `linkWithCredential`; preserved across `signInWithCredential`; after `unlink` of the last provider it is genuinely empty without re-anonymizing the user.",
  status: "conforms",
  evidence: "`unit:sandbox-linking-reauth.test.ts` + oracle: `packages/conformance/observations/auth/auth-email-credential-signin-and-providerdata.json` (verifies `initialProviderIds: []`, `afterLinkProviderIds: ['password']`, `afterCredentialSignInProviderIds: ['password']`, `afterUnlinkProviderIds: []`, `remainsNonAnonymousAfterUnlink: true`, and `afterReloadProviderIds: []` against `firebase/auth` 12.19.0).",
  automation: "oracle-backed",
  oracleObservations: ["auth-email-credential-signin-and-providerdata"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-linking-reauth.test.ts","packages/pyric/test/auth/oracle-captures/auth-providers-and-credentials.test.ts","packages/cli/test/serve/worker/oracle-captures/auth-providers-and-credentials.test.ts"],
});
