import { row } from './section.ts';

export default row({
  order: 60,
  behavior: "Rules-denied modular writes throw a `FirebaseError('permission-denied')`, matching the production error class and code",
  status: "conforms",
  evidence: "Oracle-locked by `packages/conformance/observations/firestore/firestore-rules-denied-error.json`: prod throws a `FirebaseError` (name + constructor name both `FirebaseError`), `.code === 'permission-denied'`, and the value is an `instanceof FirebaseError` and `Error`. `oracle:firestore#21` replays the same denied modular write against the sandbox and asserts that complete class shape.",
  risk: ["specific-field","rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-rules-denied-error"],
  conformanceTests: ["packages/pyric/test/firestore/oracle-conformance.test.ts"],
  conformanceChecks: [{"finding":"FS-21","observation":"firestore-rules-denied-error","expect":{"threw":true,"code":"permission-denied","errorName":"FirebaseError","constructorName":"FirebaseError","isFirebaseError":true,"isErrorInstance":true},"probe":"packages/pyric/test/firestore/oracle-conformance.test.ts","guards":"rules-denied modular writes throw the Firebase-shaped error class and permission-denied code observed in production."}],
});
