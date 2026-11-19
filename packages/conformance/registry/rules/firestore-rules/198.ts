import { row } from './section.ts';

export default row({
  order: 360,
  featureKeys: ["int", "duration", "timestamp"],
  behavior: "Integers are 64-bit: values above 2^53 keep every bit, overflow is an evaluation error except `MIN / -1`, which is `MIN`, unary minus negates a duration, and a timestamp or duration result past its range is an error (FS2-SIM-1, FS2-SIM-2, FS2-SIM-3, FS2-SIM-9)",
  status: "conforms",
  evidence: "`oracle:rules-firestore-int64-and-duration-range` (captured 2026-10-27, 22 cases) records production ALLOWING `neg duration equals duration.value(-1, 's')`, `int64 max is greater than max minus one`, `2^53 plus one differs from 2^53`, `string() of 2^53 plus one` and `min divided by minus one is min`, and DENYING `max plus one is positive`, `max timestamp plus 1 ms is later` and `duration past the protobuf bound is positive`. The simulator agrees on all 22: rules ints are int64 values held as bigints, so literals and int arithmetic keep every bit above 2^53, a result past the range is production's `Integer value is out of the [-9223372036854775808, 9223372036854775807] range.` error value except `MIN / -1`, and unary minus negates a duration (`rules/simulator/rules-int.ts`, #1335). A timestamp or duration past its range is production's `Timestamp is not valid` or `Duration is not valid` error (#1336). `unit:rules/oracle-conformance.test.ts` replays them with no pin, `unit:rules/simulator/int64.test.ts` covers each operator's overflow, its absorption by `|| true` and `&& false`, and the `Invalid number literal` compile refusal, and `unit:rules/simulator/time-range.test.ts` covers the time ranges.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts rules-denial behavior"],
  oracleObservations: ["rules-firestore-int64-and-duration-range"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/rules/test/simulator/int64.test.ts",
    "packages/rules/test/simulator/time-range.test.ts",
  ],
  constructs: [
    "firestore.operator.add",
    "firestore.operator.sub",
    "firestore.operator.div",
    "firestore.operator.unary-minus",
    "firestore.function.cast.int",
    "firestore.function.cast.string",
    "firestore.function.duration.value",
  ],
});
