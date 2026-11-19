import { row } from './section.ts';

export default row({
  order: 60,
  behavior: "**Enforcement follows the query-proof model within the supported equality subset (RULES-B11; scope limits in 24c)** — \"rules are not filters\": a doc-data-dependent `list` rule (`resource.data.visibility == 'public'`, `resource.data.owner == request.auth.uid`) is ALLOWED when the query's `where()` equalities discharge it and the whole query is `permission-denied` otherwise — never silently truncated to the readable subset. Per-doc `get` rules do NOT filter query results (the `list` rule alone governs queries — granular-operations docs). Applies to `getDocs`, aggregates, and `onSnapshot` alike. Pre-fix: rules-as-filters (per-doc `get` omission) + blanket denial of every doc-data-dependent list, even provable ones.",
  status: "conforms",
  evidence: "Local query support: `unit:firestore/query-proof-application.test.ts` covers finite membership, guardian array membership, pinned lookup paths, auth and limit controls, and adversarial array/lookup cases. Upstream semantics: firebase.google.com/docs/firestore/security/rules-query and firebase.google.com/docs/firestore/query-data/queries. Local diagnostic contract (#583): `unit:firestore/query-proof-diagnostics.test.ts` pins dynamic membership rejection, fallback attribution, constraint/residual distinctions, modular listener context, captured lifecycle errors, and immutable operation-summary proof metadata; this adds no production observation. `unit:firestore/query-proof-enforcement.test.ts` (provable/unprovable getDocs + onSnapshot, owner-pinned uid, get-rules-don't-filter, request.query.limit; verified failing pre-fix), `unit:simulator/local-environment.test.ts` (Slice 6 — flipped from per-doc-filter assertions); prod truth: firebase.google.com/docs/firestore/security/rules-query",
  risk: ["specific-value","error-code","listener","rules-denial"],
  riskScore: 9,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `permission-denied`","asserts listener semantics","asserts rules-denial behavior"],
  conformanceTests: ["packages/pyric/test/firestore/query-proof-application.test.ts","packages/pyric/test/firestore/query-proof-diagnostics.test.ts","packages/pyric/test/firestore/query-proof-enforcement.test.ts","packages/pyric/test/sandbox/firestore/simulator/local-environment.test.ts"],
  rowNumber: 24,
});
