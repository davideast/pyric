/**
 * The order rulesets the assurance suites and the tool-surface eval are both
 * measured against.
 *
 * Four rulesets over one collection, each the answer to a different question a
 * rules change asks: the rules a session was recorded under, a rewrite that
 * keeps every recorded verdict, a rewrite that keeps none of them, and the
 * permissive ruleset a campaign is supposed to find the hole in. The eval
 * corpus and the surface tests judge candidates against the same four, so they
 * live here rather than in each of them.
 */

/** The rules a session is recorded under: alice, and only alice, touches an order. */
export const RECORDED_ORDER_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /orders/{id} { allow read, write: if request.auth.uid == 'alice'; }
  }
}`;

/** Rules under which only the owner touches an order, keeping every recorded verdict. */
export const OWNER_ORDER_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /orders/{id} {
      allow read: if request.auth.uid == resource.data.owner;
      allow write: if request.auth.uid == request.resource.data.owner;
    }
  }
}`;

/** Rules that break the session: signed in is no longer enough, and nothing is. */
export const CLOSED_ORDER_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /orders/{id} { allow read, write: if false; }
  }
}`;

/** Rules with the hole a campaign is meant to find: anyone writes any order. */
export const OPEN_ORDER_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /orders/{id} { allow read, write: if true; }
  }
}`;
