import { row } from './section.ts';

export default row({
  order: 790,
  featureKeys: ["ref","push"],
  behavior: "`push(ref, value?)` returns a `ThenableReference` (a `DatabaseReference` with `.then`/`.catch`). The key + ref are minted CLIENT-SIDE and available synchronously even when the optional value write is rules-denied; the write is deferred onto the promise, so a denial REJECTS the awaited push rather than throwing synchronously and discarding the key (DB-B7)",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/push-thenable.test.ts` (4 cases); matches oracle `packages/conformance/observations/rtdb/rtdb-push-autoid-format.json` (\"available immediately even when the subsequent server write is denied by rules\") + upstream `api/Reference_impl.ts:599-630`",
  risk: ["timing","rules-denial"],
  riskScore: 4,
  riskReasons: ["asserts timing semantics","asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-push-autoid-format"],
  conformanceTests: ["packages/pyric/test/database/modular/push-thenable.test.ts"],
  rowNumber: 70,
});
