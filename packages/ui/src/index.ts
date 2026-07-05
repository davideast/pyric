// Intentionally empty. Consumers import from subpaths:
//   @pyric/ui/primitives
//   @pyric/ui/firestore
//   @pyric/ui/firestore/hooks
//
// This forces deliberate dependency choices — a consumer that only
// uses `useFirestoreDoc` doesn't pull in any primitive components,
// and vice versa.
export {};
