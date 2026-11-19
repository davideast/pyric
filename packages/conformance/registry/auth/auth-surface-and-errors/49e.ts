import { row } from './section.ts';

export default row({
  order: 10,
  rowNumber: 49,
  automation: "oracle-backed",
  behavior: "`auth.signOut()` method form works alongside the free `signOut(auth)` function (`firebase/auth`'s `Auth` exposes both) (AUTH-GAP)",
  evidence: "`unit:auth-gap-surface.test.ts`, oracle: `auth-handle-caching-live-currentuser-and-resignin.json`",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 1 specific value(s)"],
  oracleObservations: ["auth-handle-caching-live-currentuser-and-resignin"],
  conformanceTests: ["packages/pyric/test/auth/auth-gap-surface.test.ts","packages/pyric/test/auth/oracle-captures/auth-handles-persistence-disabled.test.ts","packages/cli/test/serve/worker/oracle-captures/auth-handles-persistence-disabled.test.ts"],
});
