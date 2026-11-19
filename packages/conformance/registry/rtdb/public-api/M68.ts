import { row } from './section.ts';

export default row({
  order: 770,
  featureKeys: ["set","update","push","runTransaction"],
  behavior: "Write validation: an `undefined` payload, a non-finite number (`NaN`/`±Infinity`), or a key containing a forbidden char (`.`, `#`, `$`, `/`, `[`, `]`, control chars) is rejected with a plain `Error` (DB-B1)",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/normalization.test.ts` (\"rejects an undefined payload\" + \"rejects an invalid key\" + \"rejects a non-finite number\"); matches oracle `rtdb-modular-sync-write-and-disconnect-validation.json` (synchronous throws replayed across local + SharedWorker + Node host); upstream `core/util/validation.ts:45,58,112-199`",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-sync-write-and-disconnect-validation"],
  conformanceTests: ["packages/pyric/test/database/modular/normalization.test.ts","packages/pyric/test/database/cdd/capture-normalization-and-validation.test.ts","packages/cli/test/serve/worker/oracle-captures/rtdb-normalization-and-validation.test.ts"],
  rowNumber: 68,
});
