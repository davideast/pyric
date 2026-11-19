import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["linkWithCredential"],
  api: "linkWithCredential(user, credential)",
  behavior: "The ANONYMOUS UPGRADE. Linking an email credential onto an anonymous account upgrades it IN PLACE: the uid is PRESERVED, `isAnonymous` flips to `false`, the email is set, and `providerData` gains the provider. Returns a `UserCredential` with `operationType: 'link'` and `providerId: null`, and `getAdditionalUserInfo()` reports `isNewUser: true` and `providerId: 'password'` for this upgrade. The linked credential then works as a first-class `signInWithEmailAndPassword`.",
  status: "diverged-documented",
  evidence: "Oracle `auth-link-email-credential-to-anonymous`. Divergence (#1698): the sandbox reports `isNewUser: false` and `providerId: null` for the link's additional user info. The replay pins both.",
  automation: "oracle-backed",
  oracleObservations: ["auth-link-email-credential-to-anonymous"],
  conformanceTests: ["packages/pyric/test/auth/oracle-conformance.test.ts","packages/pyric/test/auth/sandbox-linking-reauth.test.ts"],
});
