import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["getAggregateFromServer"],
  behavior: "`getAggregateFromServer(query, spec)` returns `{ data: () => Record<alias, number|null> }` for 1 to 5 aggregations and rejects 0 or >5 aggregations with `invalid-argument` in the in-page sandbox, on a served page and in a registered Node process",
  status: "conforms",
  evidence: "In-page: `unit:sandbox-target.test.ts`, `unit:aggregates.test.ts`; collectionGroup + nested paths: `unit:upstream-write-aggregate-probes.test.ts`. Production: `oracle:firestore-aggregate-field-semantics` key `countOnly` (`{ n: 4 }`), replayed through the served surface export and through the worker client and host in `unit:cli/serve/worker/oracle-captures/firestore-served-surface.test.ts`; that scenario's composite-index keys remain pinned under FL-30. A served page and a registered Node process aggregate over the host in `test/apps/client-sdk-under-register`.",
  automation: "oracle-backed",
  oracleObservations: ["firestore-aggregate-field-semantics"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts","packages/pyric/test/firestore/aggregates.test.ts","packages/pyric/test/firestore/upstream-write-aggregate-probes.test.ts","packages/cli/test/serve/worker/oracle-captures/firestore-served-surface.test.ts"],
});
