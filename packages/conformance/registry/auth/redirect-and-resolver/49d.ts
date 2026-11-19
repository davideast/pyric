import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["signInWithRedirect","getRedirectResult"],
  behavior: "`sandbox.listIdentities(auth)` snapshots every seeded/created identity for a host account-picker (sandbox-only — no `firebase/auth` equivalent)",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 1 specific value(s)"],
  exceptionReason: "sandbox-only behavior — no prod equivalent to observe",
  rowNumber: 49,
});
