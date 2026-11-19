import { row } from './section.ts';

export default row({
  order: 570,
  featureKeys: ["split", "trim", "int", "duration", "timestamp"],
  behavior: "The language semantics the Firestore hunt found hold under `firebase.storage` too: `split()` drops capture-group text and trailing empty pieces, `trim()` keeps NBSP, ints are 64-bit with overflow errors and `MIN / -1 == MIN`, a timestamp past its range is an error, and unary minus negates a duration (ST-H1-13, sharing FS2-SIM-1, FS2-SIM-2, FS2-SIM-3, FS2-SIM-4, FS2-SIM-7, FS2-SIM-8 and FS2-SIM-9)",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "`oracle:rules-storage-xref-shared-language-semantics` (captured 2026-10-27, 12 cases) records production giving the Firestore-reported answer on all 12. The evaluator agrees on all 12: `int-above-2-53-distinct` (FS2-SIM-2), `int-add-overflow-errors` and `int-min-div-minus-one` (FS2-SIM-3), since Storage's integer operators call the shared int64 arithmetic in `rules/simulator/rules-int.ts` (#1335, covered by `unit:storage/sandbox/rules-int64.test.ts`), `duration-unary-minus` (FS2-SIM-1, #1343, also covered by `unit:storage/sandbox/rules-evaluator-semantics.test.ts`), `timestamp-plus-duration-past-range-errors` under FS2-SIM-9, since the shared `Timestamp` wrapper errors past its range (#1336, replayed by `unit:rules/simulator/time-range.test.ts`), `(?i)` in `split()` and `replace()`, `duration.value()` past its range, and `trim-keeps-nbsp` under FS2-SIM-8: Storage's `trim()` now calls the shared `trimRulesString` (#1295), replayed by `unit:storage/sandbox/rules-string-methods.test.ts`. Storage's `split()` and `replace()` now call the shared `splitRe2` and `replaceRe2` (#1333), so `split-drops-capture-text` (FS2-SIM-4) and `split-drops-trailing-empty` (FS2-SIM-7) agree, and a pattern from request data gets pyric's size limit and the 1000-repeat cap; `unit:rules/simulator/split-and-replace.test.ts` checks both engines. `unit:storage/rules-oracle-conformance.test.ts` replays all 12 with no pin.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts rules-denial behavior"],
  oracleObservations: ["rules-storage-xref-shared-language-semantics"],
  conformanceTests: [
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/rules/test/storage/sandbox/rules-int64.test.ts",
    "packages/rules/test/storage/sandbox/rules-string-methods.test.ts",
    "packages/rules/test/simulator/split-and-replace.test.ts",
    "packages/rules/test/simulator/time-range.test.ts",
    "packages/rules/test/storage/sandbox/rules-evaluator-semantics.test.ts",
  ],
  constructs: [
    "storage.method.string.split",
    "storage.operator.add",
    "storage.operator.div",
    "storage.operator.unary-minus",
  ],
});
