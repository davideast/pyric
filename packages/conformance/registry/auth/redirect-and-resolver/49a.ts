import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["signInWithRedirect","getRedirectResult"],
  behavior: "`signInWithRedirect(auth, provider, resolver?)` resolves the flow (per-call resolver → injected → one-shot mock → `auth/argument-error`), signs the user in, and stashes the credential for one `getRedirectResult`",
  risk: ["specific-value","error-code"],
  riskScore: 5,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `auth/argument-error`"],
  rowNumber: 49,
});
