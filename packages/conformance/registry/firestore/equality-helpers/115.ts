import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["refEqual"],
  behavior: "`refEqual(sandboxRef, foreignRef)` throws `TypeError` — references not created by this sandbox mirror are unrecognized",
  status: "conforms",
  evidence: "`unit:sandbox-target.test.ts` (foreign refs throw unrecognized-reference TypeError)",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts"],
});
