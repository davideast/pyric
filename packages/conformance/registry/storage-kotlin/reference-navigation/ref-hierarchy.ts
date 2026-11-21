import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "StorageReference.child(path) / parent / root / path / name / bucket",
  behavior: "Navigates object hierarchies with leading-slash path, null parent at root, slash normalization, Unicode and reserved-character preservation, gs://<bucket>/<path> toString(), equality, and Comparable ordering.",
  featureKeys: ["storageReferenceNavigationHierarchyAndEqualityMatchUpstreamContract", "child", "parent"],
  status: "conforms",
  evidence: "Verified in `packages/kt-client/src/test/kotlin/dev/pyric/storage/FirebaseStorageInstanceAndRefTest.kt` (storageReferenceNavigationHierarchyAndEqualityMatchUpstreamContract) and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageEdgeCaseLiveHostConformanceTest.kt` (liveUnicodeSpacesSlashesAndReservedCharPathsRoundTripAndListCleanly).",
  tests: [
    "packages/kt-client/src/test/kotlin/dev/pyric/storage/FirebaseStorageInstanceAndRefTest.kt",
    "packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageEdgeCaseLiveHostConformanceTest.kt",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
