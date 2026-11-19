import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "Dedups by uid: a same-uid update (profile-shape change, or a same-uid re-sign-in) does NOT re-fire `onAuthStateChanged` — only an actual uid change does. Mirrors upstream `notifyAuthListeners`'s `lastNotifiedUid` gate (`auth_impl.ts:718-723`). (`onIdTokenChanged` still fires on those same-uid updates — see row 38a.)",
  evidence: "`oracle:auth-onauthstatechanged-same-uid-dedup-vs-idtoken` (fb-js-sdk 12.19.0); `unit:auth-listeners-and-middleware.test.ts` (in-page + served worker); `unit:sandbox-uid-dedup.test.ts`",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  rowNumber: 30,
  oracleObservations: ["auth-onauthstatechanged-same-uid-dedup-vs-idtoken"],
  conformanceTests: ["packages/pyric/test/auth/oracle-captures/auth-listeners-and-middleware.test.ts","packages/cli/test/serve/worker/oracle-captures/auth-listeners-and-middleware.test.ts","packages/pyric/test/auth/sandbox-uid-dedup.test.ts"],
});
