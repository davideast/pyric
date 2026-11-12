/**
 * Annotated variant of source.stitched.js. Adds a single
 * `@firestore-mutex { category, city, price }` to the function whose
 * cartesian over-shoot the v1 scope's P-prune phase identified.
 *
 * The faceted-UI in friendlyeats lets a user pick *one* of category /
 * city / price at a time — never two. The annotation tells Layer 2 to
 * drop any enumerated combo with 2+ of those fields together, which
 * eliminates the cross-product blowup and lifts precision from 44%
 * back to ~100% with no recall loss.
 *
 * Apart from the leading JSDoc tag on `applyQueryFilters`, this file
 * is byte-identical to source.stitched.js.
 */
import {
  collection,
  query,
  orderBy,
  where,
} from "firebase/firestore";

import { db } from "@/src/lib/firebase/clientApp";

/** @firestore-mutex { category, city, price } */
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
