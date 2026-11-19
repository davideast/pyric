import { row } from './section.ts';

export default row({
  order: 150,
  behavior: "Returned `metadata.generation` / `metageneration` are decimal digit strings (`metageneration === '1'` after fresh upload)",
  evidence: "Production observation `storage-uploadbytes-overwrite-generations` (firebase 12.19.0) records `generationIsDecimalDigits: true` (`typeof === 'string'`) and `metageneration === '1'` after both initial upload and overwrite. Replayed across all three planes.",
  risk: ["specific-value","metadata"],
  riskScore: 3,
  riskReasons: ["asserts 1 specific value(s)","asserts metadata shape"],
  oracleObservations: ["storage-uploadbytes-overwrite-generations"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-uploadbytes-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/metadata.test.ts"],
});
