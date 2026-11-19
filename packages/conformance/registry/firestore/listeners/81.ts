import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "`onSnapshot(query, cb)` fires on collection writes; `QuerySnapshot.docChanges()` reports `added` / `modified` / `removed` with `oldIndex` / `newIndex`",
  evidence: "`unit:sandbox-target.test.ts`, oracle: `packages/conformance/observations/firestore/firestore-row-81-onsnapshot-query-fires-on-write.json` — listener on `query(coll)` saw 1 initial fire (empty, `size:0`), then one fire per write: `addDoc` → `size:1`, `setDoc(coll, 'known-id')` → `size:2`, `deleteDoc(addedRef)` → `size:1`. Total 4 fires, each reflecting the current collection state. Every collection-level write produces a distinct fire. (Note: this oracle used a *filterless* `query(coll)`, which masked FS-B2 — see row 81a.) Modular `docChanges` indexes: `unit:upstream-transform-txn-listener-probes.test.ts`. The served worker client computes `docChanges()` in the page from consecutive snapshot frames with the change computation the in-page snapshot uses (`computeDocumentChanges` and `createDocChanges` in `snapshot-listeners.ts`); `unit:query-snapshot-doc-changes.test.ts` covers added, modified and removed with `oldIndex` and `newIndex`, the initial all-`added` snapshot, a collection-group listener, and identical change lists from the served and in-page planes for the same writes and a sign-in that re-establishes the listener",
  risk: ["specific-field","listener"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-row-81-onsnapshot-query-fires-on-write"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts","packages/pyric/test/firestore/upstream-transform-txn-listener-probes.test.ts","packages/cli/test/serve/worker/query-snapshot-doc-changes.test.ts","packages/pyric/test/sandbox/firestore/characterization/trigger-attribution.test.ts","packages/pyric/test/sandbox/firestore/characterization/delivery-ordering.test.ts"],
});
