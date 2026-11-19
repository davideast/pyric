import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "If an anonymous user is already signed in, returns the SAME user (no fresh uid mint)",
  status: "conforms",
  evidence: "`unit:sandbox-anonymous.test.ts` (\"idempotent while signed in\") — fix from #399",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/auth/sandbox-anonymous.test.ts"],
});
