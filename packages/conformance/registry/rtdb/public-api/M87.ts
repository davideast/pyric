import { row } from './section.ts';

export default row({
  order: 1000,
  featureKeys: ["query"],
  behavior: "`QueryConstraint` is exported as a runtime constructor value and constraints returned by `orderBy*`, bound, and limit factories satisfy Firebase's observable prototype and `instanceof` contract.",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-runtime-class-identity`; concrete constraint subclasses satisfy `instanceof QueryConstraint` without using the base prototype directly, replayed by row assertion `rtdb-modular#M87`.",
  risk: ["structural"],
  riskReasons: ["structural / routing-only claim"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-runtime-class-identity"],
  conformanceTests: ["packages/pyric/test/database/modular/oracle-conformance-runtime-identity.test.ts"],
  conformanceChecks: [{
    finding: "RTDB-M87",
    observation: "rtdb-modular-runtime-class-identity",
    expect: { constraintFactories: {
      orderByChild: { constructorName: "QueryOrderByChildConstraint", instanceOf: true, prototypeIsExportPrototype: false, prototypeKeys: ["_apply","constructor"] },
      orderByKey: { constructorName: "QueryOrderByKeyConstraint", instanceOf: true, prototypeIsExportPrototype: false, prototypeKeys: ["_apply","constructor"] },
      orderByPriority: { constructorName: "QueryOrderByPriorityConstraint", instanceOf: true, prototypeIsExportPrototype: false, prototypeKeys: ["_apply","constructor"] },
      orderByValue: { constructorName: "QueryOrderByValueConstraint", instanceOf: true, prototypeIsExportPrototype: false, prototypeKeys: ["_apply","constructor"] },
      startAt: { constructorName: "QueryStartAtConstraint", instanceOf: true, prototypeIsExportPrototype: false, prototypeKeys: ["_apply","constructor"] },
      startAfter: { constructorName: "QueryStartAfterConstraint", instanceOf: true, prototypeIsExportPrototype: false, prototypeKeys: ["_apply","constructor"] },
      endAt: { constructorName: "QueryEndAtConstraint", instanceOf: true, prototypeIsExportPrototype: false, prototypeKeys: ["_apply","constructor"] },
      endBefore: { constructorName: "QueryEndBeforeConstraint", instanceOf: true, prototypeIsExportPrototype: false, prototypeKeys: ["_apply","constructor"] },
      equalTo: { constructorName: "QueryEqualToValueConstraint", instanceOf: true, prototypeIsExportPrototype: false, prototypeKeys: ["_apply","constructor"] },
      limitToFirst: { constructorName: "QueryLimitToFirstConstraint", instanceOf: true, prototypeIsExportPrototype: false, prototypeKeys: ["_apply","constructor"] },
      limitToLast: { constructorName: "QueryLimitToLastConstraint", instanceOf: true, prototypeIsExportPrototype: false, prototypeKeys: ["_apply","constructor"] },
    } },
    probe: "packages/pyric/test/database/modular/oracle-conformance-runtime-identity.test.ts",
    guards: "Every public query-constraint factory preserves its captured concrete runtime identity.",
  }],
  rowNumber: 87,
});
