import { row } from './section.ts';

export default row({
  order: 20,
  status: "conforms",
  automation: "oracle-backed",
  behavior: "`QuerySnapshot.forEach(callback, thisArg)` calls `callback.call(thisArg, doc)` once per document, in query order, with the document alone, and `DocumentSnapshot.get(fieldPath)` returns the stored field at a dotted string or `FieldPath` (`undefined` when absent), for `getDocs` (with or without a converter, and the empty `getDocsFromCache` miss), `getDoc` and listener snapshots, in the in-page sandbox and through the served worker client, which the client SDKs in a Node host server process use.",
  evidence: "`unit:query-snapshot-for-each-once.test.ts` asserts the modular `getDocs` snapshot with and without a converter, a listener snapshot and the Admin-shaped query snapshot each visit every document once with `thisArg` bound and one argument, and that a write inside the callback runs once; `unit:sandbox/admin-firestore/error-translation-calls-once.test.ts` asserts the proxy calls a method once for each kind of return value; before the fix the sandbox's error-translation proxy fell back to a second call when a method returned `undefined`, so `forEach` visited every document twice. `packages/cli/test/serve/worker/query-snapshot-for-each.test.ts` asserts the served `getDocs` and listener snapshots visit the same documents in the same order and read the same fields as the in-page snapshots, and that a served `getDoc` snapshot reads a nested field and rejects an invalid field path with `invalid-argument`. App scenario `test/apps/create-pyric-node-template` scaffolds the create-pyric node template, whose `src/app.ts` calls `snap.forEach` on a `getDocs` result, and runs its `dev` script (#1203). `oracle:firestore-getdocs-foreach-thisarg-and-arity`, `oracle:firestore-snapshot-get-dotted-and-fieldpath`.",
  oracleObservations: ["firestore-getdocs-foreach-thisarg-and-arity", "firestore-snapshot-get-dotted-and-fieldpath"],
  conformanceTests: [
    "packages/pyric/test/firestore/query-snapshot-for-each-once.test.ts",
    "packages/pyric/test/sandbox/admin-firestore/error-translation-calls-once.test.ts",
    "packages/cli/test/serve/worker/query-snapshot-for-each.test.ts",
    "packages/pyric/test/firestore/oracle-captures/firestore-getdoc-getdocs.test.ts",
    "packages/cli/test/serve/worker/oracle-captures/firestore-getdoc-getdocs.test.ts",
    "test/apps/create-pyric-node-template/scenario.ts",
  ],
});
