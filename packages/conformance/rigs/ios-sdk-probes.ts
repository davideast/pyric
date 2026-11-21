import type { RigManifestRecord } from './types.ts';

/**
 * Upstream Apple / iOS Firebase SDK oracle runner (`packages/conformance/src/ios-sdk-probes.ts`).
 * Executes probe descriptors under
 * `packages/conformance/probes/{auth-swift,rtdb-swift,firestore-swift}/<name>.ts`
 * declaring `rig: 'ios-sdk-probes'` against real `firebase-ios-sdk` (`FirebaseDatabase`
 * via headless macOS SwiftPM CLI and `FirebaseAuth` + `FirebaseFirestore` via unsigned
 * iOS Simulator `xcodebuild test CODE_SIGNING_ALLOWED=NO`) on `macos-latest`.
 */
export const rig: RigManifestRecord = {
  description:
    'Upstream Apple / iOS Firebase SDK oracle runner over packages/conformance/probes/{auth-swift,rtdb-swift,firestore-swift}/<name>.ts using headless macOS SwiftPM for FirebaseDatabase and unsigned iOS Simulator xcodebuild test for FirebaseAuth and FirebaseFirestore.',
  script: 'packages/conformance/src/ios-sdk-probes.ts',
  observationPrefixes: [],
  probeDeclaredOwnership: true,
  automation: 'credentialed',
  network: 'firebase-production',
  runnerOs: 'macos-latest',
  requires: {
    env: [
      {
        name: 'PYRIC_ORACLE_PROJECT_ID',
        description:
          'Oracle Firebase project id when authenticating through main-only Workload Identity Federation or Application Default Credentials.',
        permission:
          'roles/firebase.viewer, roles/firebaseauth.admin, roles/firebasedatabase.admin, roles/firebaserules.admin, roles/datastore.user',
      },
      {
        name: 'PYRIC_ORACLE_SA_PATH',
        description:
          'Optional service-account key JSON path when not using Application Default Credentials.',
        permission:
          'roles/firebase.viewer, roles/firebaseauth.admin, roles/firebasedatabase.admin, roles/firebaserules.admin, roles/datastore.user',
      },
      {
        name: 'PYRIC_ORACLE_FIREBASE_CONFIG',
        description:
          'Optional Firebase client config JSON override for the dedicated oracle project; when unset, discovered automatically via the Firebase Management REST API.',
      },
      {
        name: 'PYRIC_ORACLE_RTDB_URL',
        description:
          'Dedicated non-default RTDB instance URL (e.g. https://pyric-oracle-rtdb-2.firebaseio.com), required by rtdb-swift probes.',
        permission: 'roles/firebasedatabase.admin',
      },
    ],
    projectFeatures: [
      'Anonymous sign-in enabled on the dedicated oracle project.',
      'Email/Password sign-in enabled on the dedicated oracle project.',
      'Dedicated non-default Realtime Database instance provisioned.',
      'Cloud Firestore default database provisioned in Native mode.',
    ],
    local: [
      'macOS host with Xcode 26.4+ (Swift 6.3+) and an available iOS Simulator runtime.',
    ],
  },
  safety: {
    writes:
      'Ephemeral Firebase Auth test accounts, run-scoped RTDB nodes + temporary subtree rules under pyric_oracle/<runId> on the dedicated non-default RTDB instance, and run-scoped Cloud Firestore documents + temporary rules under pyric_oracle/<runId>.',
    cleanup:
      'Deletes created Auth accounts via firebase-admin/auth, recursively deletes pyric_oracle/<runId> Firestore documents and RTDB subtrees, restores and verifies live Firestore and RTDB rules in finally and SIGINT/SIGTERM, and removes private job temp directories.',
    unattendedSafe: true,
  },
  freshness: {
    versionField: 'iosSdkVersion',
    policy:
      'Checked by packages/conformance/src/check-observation-versions.ts against firebaseIosSdkVersion in packages/conformance/rigs/native-ios-oracle/sdk-version.properties.',
  },
};
