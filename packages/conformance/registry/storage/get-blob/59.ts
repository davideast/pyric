import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "Throws `storage/object-not-found` for missing paths",
  evidence: "`unit:reference.test.ts` (\"throws storage/object-not-found for missing paths\")",
  risk: ["specific-value","error-code"],
  riskScore: 5,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `storage/object-not-found`"],
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/storage/reference.test.ts"],
});
