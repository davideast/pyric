import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["evaluateStorageRules","request.auth"],
  behavior: "`evaluateStorageRules` matches `match /sessions/{id} { allow read: if request.auth != null; }` for an authed read",
  status: "conforms",
  evidence: "`oracle:rules-storage-auth-non-null-read-guard` (5 cases: signed-in `get`/`list` ALLOW, anonymous `get`/`list` DENY, unmatched path DENY), replayed by `unit:rules/storage/rules-oracle-conformance.test.ts` and `unit:storage/sandbox/rules-evaluator.test.ts`",
  oracleObservations: ["rules-storage-auth-non-null-read-guard"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts", "packages/rules/test/storage/sandbox/rules-evaluator.test.ts"],
});
