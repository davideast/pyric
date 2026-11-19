import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "An unrecognized persistence marker is rejected with `auth/argument-error` rather than silently coerced to LOCAL",
  status: "conforms",
  evidence: "`unit:sandbox-cluster-b9-b12.test.ts` (locks AUTH-B12)",
  risk: ["specific-value","error-code"],
  riskScore: 5,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `auth/argument-error`"],
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/auth/sandbox-cluster-b9-b12.test.ts"],
  rowNumber: 43,
});
