import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "Sets `currentUser` to `null` synchronously after resolution",
  status: "conforms",
  evidence: "`playground:auth-anonymous` (bundled) + `playground:auth-row-25-signout-currentuser-null` (one-claim), `unit:sandbox-anonymous.test.ts` + oracle: `packages/conformance/observations/auth/auth-row-25-signout-currentuser-null-sync.json` (`currentUserIsNullSync: true` against digame-mas, fb-js-sdk 12.19.0 — `auth.currentUser` read in the synchronous continuation immediately after `await signOut(auth)` is already `null`, with no microtask/macrotask required to settle)",
  risk: ["specific-field","timing"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts timing semantics"],
  automation: "oracle-backed",
  oracleObservations: ["auth-row-25-signout-currentuser-null-sync"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-anonymous.test.ts"],
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
