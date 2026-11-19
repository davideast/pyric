import { row } from './section.ts';

export default row({
  order: 450,
  featureKeys: ["int"],
  behavior: "Integers are 64-bit: distinct values above 2^53 compare unequal, `int()` and `string()` keep every bit, and overflow is an evaluation error (ST-H1-4, sharing FS2-SIM-2 and FS2-SIM-3)",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "`oracle:rules-storage-h1-int64-precision` (captured 2026-10-27, 9 cases) records production DENYING `9007199254740993 == 9007199254740992` and `9223372036854775807 + 1 > 0`, and ALLOWING `9223372036854775807 > 9223372036854775806`, `9007199254740993 - 1 == 9007199254740992` and `string(9007199254740993) == '9007199254740993'`. The evaluator agrees on all 9: Storage's integer operators call the shared int64 arithmetic in `rules/simulator/rules-int.ts` (#1335), so literals, `int()` and `string()` keep every bit and overflow is production's `Integer value is out of the range` error value. `unit:storage/rules-oracle-conformance.test.ts` replays them with no pin, and `unit:storage/sandbox/rules-int64.test.ts` covers each operator's overflow and the `Invalid number literal` compile refusal.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts rules-denial behavior"],
  oracleObservations: ["rules-storage-h1-int64-precision"],
  conformanceTests: [
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/rules/test/storage/sandbox/rules-int64.test.ts",
  ],
  constructs: ["storage.operator.add", "storage.operator.sub", "storage.function.cast.int", "storage.function.cast.string"],
});
