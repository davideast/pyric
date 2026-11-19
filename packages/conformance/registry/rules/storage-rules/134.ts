import { row } from './section.ts';

export default row({
  order: 340,
  featureKeys: ["firestore.get", "firestore.exists", "crossServiceIam"],
  behavior: "Storage to Firestore IAM boundary: without `roles/firebaserules.firestoreServiceAgent` on the Storage service agent, every EXECUTED `firestore.get()/exists()` lookup fails and the rule DENIES, while a short-circuited lookup is never executed and its rule still ALLOWS. Modeled by the `crossServiceIam: 'granted' | 'denied'` storage sandbox option (default granted)",
  status: "conforms",
  evidence: "PROMOTED, 2026-08-31: the real-resource IAM-DISABLED deploy-observe-restore baseline `oracle:stdlib-realstorage-p3-lookup-budget` (previously an excused negative capture, and the sibling of row #131's IAM-enabled twin: same probe matrix, role removed) pins one/two/three/repeat/get-exists/missing-* = DENY and short = ALLOW. `unit:conformance/storage-stdlib-real-replay.test.ts` replays all 8 captured verdicts against the local evaluator injected with the EXACT production denied-mode lookup (`crossServiceIamDeniedLookup` from storage/enforce.ts); `unit:pyric/test/e2e-soundness/cross-service-iam.test.ts` proves the `crossServiceIam` option reaches that lookup through the full sandbox enforcement path, that granted and default behavior is unchanged, and that a late differing mode throws. Scope: the capture pins only the executed-lookup/short-circuit boundary. How an IAM failure composes with CEL `&&`/`||` error absorption was not exercised IAM-disabled and remains unpinned; the denied-mode error uses the evaluator's absorbable error class, the existing no-capability precedent.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts rules-denial behavior at a cross-service IAM boundary"],
  automation: "oracle-backed",
  oracleObservations: ["stdlib-realstorage-p3-lookup-budget"],
  conformanceTests: [
    "packages/conformance/test/src/storage-stdlib-real-replay.test.ts",
    "packages/pyric/test/e2e-soundness/cross-service-iam.test.ts",
  ],
  constructs: ["storage.function.firestore.get", "storage.function.firestore.exists"],
});
