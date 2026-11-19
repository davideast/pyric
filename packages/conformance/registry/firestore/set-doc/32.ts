import { row } from './section.ts';

export default row({
  order: 70,
  behavior: "Rules-denied `setDoc` throws a `FirebaseError` with code `permission-denied`, matching production",
  evidence: "`unit:sandbox-target.test.ts` (\"getDoc denies when rules reject\"), `playground:rules-data-validation`, oracle: `packages/conformance/observations/firestore/firestore-write-denied-error-code.json` (prod `setDoc` on a denied path throws a `FirebaseError` with `.code === 'permission-denied'`, `.message === '7 PERMISSION_DENIED: Missing or insufficient permissions.'`, `instanceof Error`); `oracle:firestore#32` pins the sandbox error shape",
  risk: ["specific-value","error-code","specific-field","rules-denial"],
  riskScore: 8,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `permission-denied`","asserts a specific field/property value","asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-write-denied-error-code"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts","packages/pyric/test/firestore/oracle-conformance.test.ts"],
  conformanceChecks: [{
    finding: "FS-32",
    observation: "firestore-write-denied-error-code",
    expect: {
      code: "permission-denied",
      errorName: "FirebaseError",
      constructorName: "FirebaseError",
      isFirebaseError: true,
      isErrorInstance: true,
    },
    probe: "packages/pyric/test/firestore/oracle-conformance.test.ts",
    guards: "Rules-denied setDoc throws the production FirebaseError class with the permission-denied code.",
  }],
});
