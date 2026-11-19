import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "An EMPTY password throws `auth/missing-password` (message \"A non-empty password must be provided\"), fired before the user-DB lookup so it can't be used to enumerate seeded emails. Upstream maps the `MISSING_PASSWORD` server error (`core/errors.ts:92,282,563`). ⚠ best-known semantics — message text not yet captured against a live project (STOP-flagged for an oracle pass; the `.code` is the load-bearing part).",
  status: "diverged-documented",
  evidence: "`unit:sandbox-cluster-b9-b12.test.ts` (locks AUTH-B11)",
  risk: ["specific-value","error-code","listener"],
  riskScore: 7,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `auth/missing-password`","asserts listener semantics"],
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/auth/sandbox-cluster-b9-b12.test.ts"],
  rowNumber: 15,
});
