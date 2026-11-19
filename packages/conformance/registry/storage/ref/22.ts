import { row } from './section.ts';

export default row({
  order: 100,
  behavior: "Reference identity: two `ref(s, 'a/b')` calls are equal-by-`toString` but NOT `===` (value objects, not interned)",
  evidence: "Production observation `client-storage-ref-identity-and-storage-handle` (firebase 12.19.0) records `samePathStrictEqual: false`, `samePathToStringEqual: true`, `rootCallsStrictEqual: false`, `rootGetterOnRootStrictEqualSelf: false`, `repeatedParentGetterStrictEqual: false`, and `repeatedRootGetterStrictEqual: false`. Replayed across all three planes.",
  oracleObservations: ["client-storage-ref-identity-and-storage-handle"],
});
