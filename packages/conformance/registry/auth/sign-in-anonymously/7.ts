import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "Auto-generates a uid for fresh sign-ins (sandbox format: `anonymous-{N}`)",
  status: "diverged-documented",
  statusNote: "format",
  evidence: "`unit:sandbox-anonymous.test.ts` — prod uids are 28-char base64-ish; sandbox uses a readable counter for debuggability",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/auth/sandbox-anonymous.test.ts"],
});
