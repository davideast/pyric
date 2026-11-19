import { row } from './section.ts';

export default row({
  order: 410,
  featureKeys: ["comparison"],
  behavior: "`==`, `!=` and `===` with an object value from `val()` compare as production compares them: an object is never equal to anything, an identical object included, and `!=` is true, without failing the rule (SP-3 refuted)",
  evidence: "`oracle:rules-rtdb-r48-object-equality` (captured 2026-10-26, 10 cases) records production DENYING `data.val() == data.val()` on a stored object, `data.val() == newData.val()` and `===` over identical objects, ALLOWING `!=` over identical and different objects, and ALLOWING `!(newData.val() == 'x')` and `!(newData.val() == null)` for an object, which shows `==` with an object operand is false rather than a rule error. Number controls under `==` and `!=` allow. The simulator matches all 10 verdicts.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts equality over object values allows and denies as production does"],
  oracleObservations: ["rules-rtdb-r48-object-equality"],
  constructs: ["rtdb.operator.looseEq", "rtdb.operator.looseNeq", "rtdb.operator.strictEq"],
});
