# friendlyeats — Firestore index extraction fixture

Real-world corpus for validating the `firestore_extract_indexes` tool
end-to-end against ground-truth deployed indexes.

## Provenance

Source files copied from
[`firebase/friendlyeats-web`](https://github.com/firebase/friendlyeats-web)
(Apache 2.0). See `LICENSE` and `NOTICE` for attribution.

- `source.original.js` — verbatim copy of the project's
  `src/lib/firebase/firestore.js` (Firestore data layer).
- `expected.indexes.json` — verbatim copy of the project's deployed
  `firestore.indexes.json`.
- `source.stitched.js` — derived: the `applyQueryFilters` body with the
  INIT site (`let q = query(collection(db, "restaurants"))`) inlined
  from the caller `getRestaurants`. Models what Layer 2 will produce
  after inter-procedural stitching (see issue I1 in the progress doc).

## Why a stitched variant?

The friendlyeats wrap pattern splits the query base across functions:

```js
// getRestaurants
let q = query(collection(db, "restaurants"));
return getRestaurants(applyQueryFilters(q, filters));

// applyQueryFilters
function applyQueryFilters(q, ...) { /* wrap-pattern body */ }
```

Layer 1 is intra-procedural only — it sees `q` as a parameter inside
`applyQueryFilters` with no INIT in the same body and emits a
`partial-base` warning. The `source.stitched.js` fixture represents the
shape Layer 2 produces by following the call graph back to the caller
and inlining the base.

The corpus test asserts:
1. `source.stitched.js` → recovers all 8 deployed indexes (recall 8/8).
2. `source.original.js` → emits `partial-base` warning, documenting the
   inter-procedural gap that motivates Layer 2.
