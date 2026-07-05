/**
 * Stitched variant of the friendlyeats `applyQueryFilters` body — the
 * INIT site (`let q = query(collection(db, "restaurants"))`) from the
 * caller `getRestaurants` is inlined as the first statement.
 *
 * This represents the post-inter-procedural shape Layer 2 will produce
 * when it follows the call graph from `getRestaurants` → `applyQueryFilters`.
 * Layer 1's intra-procedural extractor cannot stitch the base across
 * function boundaries (issue I1 in the progress doc), so we vendor the
 * stitched form here to validate the extractor's enumeration + composite
 * detection against the deployed-indexes ground truth.
 *
 * Apart from inlining the base, the body is byte-identical to
 * `applyQueryFilters` in source.original.js.
 */
import {
  collection,
  query,
  orderBy,
  where,
} from "firebase/firestore";

import { db } from "@/src/lib/firebase/clientApp";

function applyQueryFilters({ category, city, price, sort }) {
  let q = query(collection(db, "restaurants"));
  if (category) {
    q = query(q, where("category", "==", category));
  }
  if (city) {
    q = query(q, where("city", "==", city));
  }
  if (price) {
    q = query(q, where("price", "==", price.length));
  }
  if (sort === "Rating" || !sort) {
    q = query(q, orderBy("avgRating", "desc"));
  } else if (sort === "Review") {
    q = query(q, orderBy("numRatings", "desc"));
  }
  return q;
}
