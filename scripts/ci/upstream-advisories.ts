/**
 * Advisories `npm audit --json` reports in a fresh install that are known
 * upstream and unreachable from the app, keyed by GitHub advisory id. The
 * Fresh install findings name the reason after the advisory line instead of
 * leaving it unexplained. Each reason says where the package comes from and
 * why the vulnerable code does not run; an entry leaves this table when the
 * advisory stops appearing or a fixed release becomes installable.
 */
export const UPSTREAM_ADVISORIES: Readonly<Record<string, string>> = {
  // @firebase/firestore declares @grpc/grpc-js ~1.9.0, and the 1.9 line has no fixed release (#2120).
  'GHSA-m9gg-hp2v-232j':
    '@grpc/grpc-js comes from the app\'s own firebase; the bug is in grpc server auth, and Firestore uses grpc-js only as a client in its Node build',
};
