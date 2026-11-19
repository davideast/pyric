import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "Fires on BOTH directions: a real sign-in (`nextUser` non-null) and a real sign-out (`nextUser === null`) — a throwing callback blocks `signOut` too, leaving the previous user signed in. Matches upstream, where the same middleware queue gates `_updateCurrentUser` and `signOut`.",
  status: "conforms",
  automation: "oracle-backed",
  risk: ["listener","specific-value"],
  riskScore: 4,
  rowNumber: 76,
  evidence: "`oracle:auth-beforeauthstatechanged-block-signin-and-signout` (fb-js-sdk 12.19.0); `unit:auth-listeners-and-middleware.test.ts` (in-page); `unit:sandbox-before-auth-state-changed.test.ts`",
  riskReasons: ["asserts listener semantics","asserts a specific value"],
  oracleObservations: ["auth-beforeauthstatechanged-block-signin-and-signout"],
  conformanceTests: ["packages/pyric/test/auth/oracle-captures/auth-listeners-and-middleware.test.ts","packages/pyric/test/auth/sandbox-before-auth-state-changed.test.ts"],
});
