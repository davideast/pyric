---
name: firestore-query-indexes
description: Design Firestore query shapes and the composite indexes they require — filters, ordering, pagination, collection groups, denormalized reads. Use when the user plans Firestore reads, hits a missing-index error, or asks for firestore.indexes.json.
---

# Firestore Query & Index Design

A query plan is an index proof: name what the product must read, prove each
query is allowed by rules, and extract the composite indexes the code
requires. Model reads first — slow Firestore apps usually download too many
documents, not scan too many.

## Steps

1. **Inventory query intents.** For each screen, report, listener, or search:
   collection path (or collection group), filters, `orderBy` fields, limit,
   cursor strategy, auth identity, and expected result size. Complete when
   every read the product performs is a row in the inventory.

2. **Choose read shapes.** Options per intent: direct document read,
   top-level collection query, subcollection query (removes a `where` for
   single-parent reads), collection-group query (cross-parent subcollection
   reads), or a denormalized summary document. Complete when each intent has
   a shape and a one-line justification.

3. **Prove rules compatibility.** Rules are not filters: a list query must be
   constrained (`where` on owner/membership fields) so it can only return
   documents its identity may read. Verify with `firestore_rules.simulate`
   per identity, or a `firestore_rules.test` case per query. Complete when
   every list query has a matching rule + constraint pair.

4. **Write the query code** in modular SDK shape inside a function body —
   `query(collection(db, ...), where(...), orderBy(...))` — so the extractor
   can see it. Complete when each inventory row has code.

5. **Extract indexes.** Run `firestore_extract_indexes` over the query code
   after every change. It returns `firestore.indexes.json`-shaped config plus
   warnings. Zero extracted shapes means the source didn't expose a pattern
   (missing file, admin-chain syntax, no composite query) — report that and
   fix the source; never hand-write index JSON the extractor didn't produce.
   Review `overshootSuspected` warnings; a targeted `@firestore-mutex`
   annotation trims shapes enumerated from mutually exclusive branches.
   Complete when extraction succeeds with reviewed warnings.

6. **Deploy and confirm.** Write the reviewed config to
   `firestore.indexes.json`, then apply it with
   `npx firebase-tools deploy --only firestore:indexes`. Confirm each build is
   ready in Firebase before exercising the query. Complete when every
   composite query has a ready index.

7. **Verify against data.** Run representative queries with
   `firestore_data.query` (seed via `firestore_data.batch_write` if needed) and
   confirm result shape and size match the inventory. Complete when each
   intent returns what its screen expects.

## Reference — query rules

- Single-field queries index automatically; combined filters/order need
  composite indexes.
- Arrays take `array-contains` / `array-contains-any`; use a real array, not
  a map-as-tag shape, when membership is the access pattern.
- Paginate with cursors, never growing limits or offsets.
- Document reads are shallow — subcollections do not ride along.
- Denormalization is a spectrum: duplicate slow-changing display data when it
  removes repeated lookups or impossible joins; plan fan-out writes to keep
  copies consistent.
