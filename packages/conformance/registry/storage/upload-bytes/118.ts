import { row } from './section.ts';

export default row({
  order: 160,
  behavior: "Each write of an object gets a new, larger `generation`, a numeric string, even in one millisecond, under a fixed clock, or from two sandboxes on one store",
  evidence: "Production observation `storage-uploadbytes-overwrite-generations` (firebase 12.19.0) records `generationChanged: true` and `generationStrictlyIncreased: true` (`BigInt(second.generation) > BigInt(first.generation)`), with `storage-upload-then-getmetadata` pinning the decimal string shape. The backend issues it in the write's transaction above a per-path mark kept in the same store (`clock ms * 1000`). Replayed across `pyric/storage`, SharedWorker, Node host, and `pyric-admin`.",
  risk: ["specific-value","metadata"],
  riskScore: 3,
  riskReasons: ["asserts 1 specific value(s)","asserts metadata shape"],
  oracleObservations: ["storage-uploadbytes-overwrite-generations","storage-upload-then-getmetadata"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-uploadbytes-parity.test.ts","packages/pyric/test/storage/generation.test.ts","packages/pyric/test/storage/generation-high-water.test.ts","packages/cli/test/serve/worker/storage-generation.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric-admin/test/storage/generations.test.ts"],
});
