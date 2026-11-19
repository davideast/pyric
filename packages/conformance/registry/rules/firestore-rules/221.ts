import { row } from './section.ts';

export default row({
  order: 430,
  featureKeys: ["match"],
  behavior: "The `allow` statements written on a root `match /databases/{database}/documents` block grant no document: that root does not match a document's full resource name, only its children do",
  status: "conforms",
  evidence: "`oracle:rules-firestore-root-documents-own-allow` (captured 2026-11-04, 1 case) records production DENYING get `c/1` under an `allow read: if true` written on the root `/databases/{database}/documents`. `unit:rules/oracle-conformance.test.ts` replays the verdict with no pin.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts that the rules on a root ending at documents do not grant a document"],
  oracleObservations: ["rules-firestore-root-documents-own-allow"],
  constructs: ["firestore.rule-kind.match"],
});
