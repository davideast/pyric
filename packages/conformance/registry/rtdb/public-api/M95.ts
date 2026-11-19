import { row } from './section.ts';

export default row({
  order: 1080,
  featureKeys: ["set","setWithPriority","setPriority","remove","push","update","runTransaction","onDisconnect"],
  behavior: "`/.info` is read-only: `set`, `setWithPriority`, `setPriority`, `remove`, `push`, `runTransaction` and every `onDisconnect` write on a location under `/.info` throw synchronously with `<method> failed = Can't modify data under /.info/`, an `update` from the root with a `.info/` key throws the invalid-key error, an `update` on a `.info` reference rejects with `INVALID_PARAMETERS`, and no such write changes data",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-info-write-validation` (captured 2026-10-07) runs each write twice against production and records the timing, code and message of each failure; `unit:modular/info-write-validation.test.ts` replays every captured field and checks the sandbox state is unchanged. The served worker client applies the same check before it sends a write.",
  risk: ["validation-timing","specific-value"],
  riskScore: 3,
  riskReasons: ["asserts synchronous validation phase","asserts exact validation error shapes"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-info-write-validation"],
  conformanceTests: [
    "packages/pyric/test/database/modular/info-write-validation.test.ts",
    "packages/pyric/test/database/cdd/public-operations.test.ts",
  ],
  rowNumber: 95,
});
